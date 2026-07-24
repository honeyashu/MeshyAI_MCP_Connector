/**
 * Generation lifecycle orchestrator.
 * Manages the full lifecycle of 3D generation tasks across multiple providers.
 * Handles preview→refine chaining, rig→animate sequencing, and retry/backoff
 * (delegated to RetryPolicy.ts, Phase 8).
 *
 * DECISION: Text-to-3D preview→refine is NOT auto-chained. Caller must explicitly
 * invoke textToRefine() once the preview task succeeds. This is more predictable for
 * API consumers and avoids hidden async behavior. See textToPreview() JSDoc.
 *
 * DECISION: Job state is held in-memory (Map<taskId, JobMetadata>) by default, with
 * an optional JobStore for persistence (Phase 6, src/store/jobStore.ts). See constructor.
 */

import type {
  IAI3DProvider,
  TextToPreviewRequest,
  TextToRefineRequest,
  ImageToThreeDRequest,
  MultiImageToThreeDRequest,
  RiggingRequest,
  AnimationRequest,
  JobStatus,
} from "./IAI3DProvider.js";
import type { JobMetadata, JobStoreInterface } from "./types.js";
import { JobState, GenerationMode as GenerationModeEnum } from "./types.js";
import {
  withRetry,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from "./RetryPolicy.js";
import { logger } from "./Logger.js";

/**
 * Generation lifecycle orchestrator.
 * Works with any IAI3DProvider. Holds in-memory job state, optionally mirrored to a
 * JobStoreInterface (e.g. the SQLite-backed store in store/jobStore.ts, Phase 6) for
 * persistence across process restarts. Without a store, state is in-memory only.
 */
export class GenerationManager {
  private provider: IAI3DProvider;
  private jobs: Map<string, JobMetadata> = new Map();
  private jobStore?: JobStoreInterface;
  private retryConfig: BackoffConfig;
  private nextJobIndex: number = 0;

  constructor(
    provider: IAI3DProvider,
    retryConfig: Partial<BackoffConfig> = {},
    jobStore?: JobStoreInterface,
  ) {
    this.provider = provider;
    this.jobStore = jobStore;
    this.retryConfig = {
      maxRetries: retryConfig.maxRetries ?? DEFAULT_BACKOFF_CONFIG.maxRetries,
      initialDelayMs:
        retryConfig.initialDelayMs ?? DEFAULT_BACKOFF_CONFIG.initialDelayMs,
      maxDelayMs: retryConfig.maxDelayMs ?? DEFAULT_BACKOFF_CONFIG.maxDelayMs,
      jitter: retryConfig.jitter ?? DEFAULT_BACKOFF_CONFIG.jitter,
    };
  }

  /**
   * Guards against a provider returning a falsy task ID after a create-task call
   * has already succeeded (and, for paid providers, already spent credits). This
   * is a defense-in-depth check: `MeshyProvider` already throws immediately if
   * Meshy's response doesn't contain a task ID, but a provider bug of this exact
   * shape (crashing on `taskId.slice(...)` well after the billable work happened,
   * with no indication the task was actually created) is exactly the failure mode
   * this project has already shipped once — see MeshyClient.ts's
   * `MeshyCreateTaskResponse` doc comment for the history. Failing loudly and
   * immediately here, for every provider, is cheap insurance against a repeat.
   */
  private assertTaskId(taskId: string, methodLabel: string): void {
    if (!taskId) {
      throw new Error(
        `Provider "${this.provider.providerId}" returned an empty task ID from ` +
          `${methodLabel}(). The task may have still been created (and any credits ` +
          `spent) — check the provider's dashboard or list_jobs before retrying.`,
      );
    }
  }

  /**
   * Records a job in local memory and, if configured, the persistent job store.
   * Store failures are logged but never block the caller — the in-memory map is
   * always the source of truth for the current process.
   */
  private async trackJob(job: JobMetadata): Promise<void> {
    this.jobs.set(job.taskId, job);
    logger.info(`Job created: ${job.generationMode}`, {
      jobId: job.jobId,
      taskId: job.taskId,
      provider: job.provider,
    });

    if (this.jobStore) {
      try {
        await this.jobStore.save(job);
      } catch (error) {
        logger.warn(
          "Failed to persist job to job store; continuing with in-memory state only",
          {
            jobId: job.jobId,
            taskId: job.taskId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  /**
   * Generates a 3D model from a text prompt (preview phase, untextured).
   *
   * This method creates a preview task (untextured mesh). To add texturing,
   * the caller must explicitly invoke textToRefine() once this task succeeds.
   * This is intentional: preview→refine chaining is NOT automatic. This keeps
   * the API predictable and avoids hidden async side effects.
   *
   * @returns Task ID for polling status
   */
  async textToPreview(request: TextToPreviewRequest): Promise<string> {
    const taskId = await withRetry(
      () => this.provider.textToPreview(request),
      this.retryConfig,
    );
    this.assertTaskId(taskId, "textToPreview");

    // Record job metadata
    const jobMetadata: JobMetadata = {
      jobId: this.generateJobId(),
      taskId,
      provider: this.provider.providerId,
      generationMode: GenerationModeEnum.TextToPreview,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      modelType: request.modelType,
      targetFormats: request.targetFormats || [],
      meshName: `text-preview-${taskId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    await this.trackJob(jobMetadata);
    return taskId;
  }

  /**
   * Refines a text-to-3D preview with texturing and format selection.
   * Caller must provide the preview task ID from a successful textToPreview() call.
   *
   * @param previewTaskId The task ID of a completed text-to-preview task
   * @returns New task ID for the refinement task (different from preview)
   */
  async textToRefine(
    previewTaskId: string,
    request: TextToRefineRequest,
  ): Promise<string> {
    // Verify preview task exists and is complete
    const previewJob = this.jobs.get(previewTaskId);
    if (!previewJob) {
      throw new Error(`Preview task ${previewTaskId} not found in local state`);
    }

    // Get current status to confirm it succeeded
    const previewStatus = await this.provider.getJobStatus(previewTaskId);
    if (previewStatus.state !== JobState.Completed) {
      throw new Error(
        `Cannot refine: preview task is in state ${previewStatus.state}, not ${JobState.Completed}`,
      );
    }

    // Issue the refine task
    const refineRequest: TextToRefineRequest = {
      ...request,
      previewTaskId,
    };

    const taskId = await withRetry(
      () => this.provider.textToRefine(refineRequest),
      this.retryConfig,
    );
    this.assertTaskId(taskId, "textToRefine");

    // Record the refine job
    const refineJob: JobMetadata = {
      jobId: this.generateJobId(),
      taskId,
      provider: this.provider.providerId,
      generationMode: GenerationModeEnum.TextToRefine,
      prompt: previewJob.prompt,
      negativePrompt: previewJob.negativePrompt,
      targetFormats: request.targetFormats || [],
      meshName: `text-refine-${taskId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    await this.trackJob(refineJob);
    return taskId;
  }

  /**
   * Generates a 3D model from a single image.
   * Texturing is inline (controlled by shouldTexture, enablePbr, etc.).
   * No chaining needed — texturing happens as part of the single request.
   *
   * @returns Task ID for polling status
   */
  async imageToThreeD(request: ImageToThreeDRequest): Promise<string> {
    const taskId = await withRetry(
      () => this.provider.imageToThreeD(request),
      this.retryConfig,
    );
    this.assertTaskId(taskId, "imageToThreeD");

    const jobMetadata: JobMetadata = {
      jobId: this.generateJobId(),
      taskId,
      provider: this.provider.providerId,
      generationMode: GenerationModeEnum.ImageToThreeD,
      prompt: request.imageUrl || "(image input)",
      targetFormats: request.targetFormats || [],
      meshName: `image-${taskId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    await this.trackJob(jobMetadata);
    return taskId;
  }

  /**
   * Generates a 3D model from multiple images (1-4).
   * Texturing is inline (controlled by shouldTexture, enablePbr, etc.).
   *
   * @returns Task ID for polling status
   */
  async multiImageToThreeD(
    request: MultiImageToThreeDRequest,
  ): Promise<string> {
    const taskId = await withRetry(
      () => this.provider.multiImageToThreeD(request),
      this.retryConfig,
    );
    this.assertTaskId(taskId, "multiImageToThreeD");

    const jobMetadata: JobMetadata = {
      jobId: this.generateJobId(),
      taskId,
      provider: this.provider.providerId,
      generationMode: GenerationModeEnum.MultiImageToThreeD,
      prompt: `${request.imageUrls.length} images`,
      targetFormats: request.targetFormats || [],
      meshName: `multi-image-${taskId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    await this.trackJob(jobMetadata);
    return taskId;
  }

  /**
   * Rigs a humanoid 3D model.
   * Caller must provide the model URL or input_task_id from a completed generation.
   * Does NOT automatically chain into animateModel() — caller triggers animation explicitly.
   *
   * @returns Task ID for rigging task
   */
  async rigModel(request: RiggingRequest): Promise<string> {
    // Check capability first (rigModel is optional on IAI3DProvider)
    if (!this.provider.capabilities.supportsRigging) {
      throw new Error(
        `Provider "${this.provider.providerId}" does not support rigging`,
      );
    }

    if (!this.provider.rigModel) {
      throw new Error(
        `Provider "${this.provider.providerId}" declares rigging support but rigModel method is missing`,
      );
    }

    const taskId = await withRetry(
      () => this.provider.rigModel!(request),
      this.retryConfig,
    );
    this.assertTaskId(taskId, "rigModel");

    const jobMetadata: JobMetadata = {
      jobId: this.generateJobId(),
      taskId,
      provider: this.provider.providerId,
      generationMode: GenerationModeEnum.Rigging,
      prompt: request.inputTaskId
        ? `Rig: ${request.inputTaskId}`
        : "Rig: model URL",
      targetFormats: [],
      meshName: `rig-${taskId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    await this.trackJob(jobMetadata);
    return taskId;
  }

  /**
   * Animates a rigged 3D model.
   * Caller must provide the rig task ID from a successful rigModel() call.
   *
   * @param rigTaskId Task ID of a completed rigging task
   * @returns Animation task ID
   */
  async animateModel(
    rigTaskId: string,
    request: Omit<AnimationRequest, "rigTaskId">,
  ): Promise<string> {
    // Check capability first (animateModel is optional on IAI3DProvider)
    if (!this.provider.capabilities.supportsAnimation) {
      throw new Error(
        `Provider "${this.provider.providerId}" does not support animation`,
      );
    }

    if (!this.provider.animateModel) {
      throw new Error(
        `Provider "${this.provider.providerId}" declares animation support but animateModel method is missing`,
      );
    }

    // Verify rig task exists and is complete
    const rigJob = this.jobs.get(rigTaskId);
    if (!rigJob) {
      throw new Error(`Rig task ${rigTaskId} not found in local state`);
    }

    // Get current status to confirm it succeeded
    const rigStatus = await this.provider.getJobStatus(rigTaskId);
    if (rigStatus.state !== JobState.Completed) {
      throw new Error(
        `Cannot animate: rig task is in state ${rigStatus.state}, not ${JobState.Completed}`,
      );
    }

    // Issue the animation task
    const animRequest: AnimationRequest = {
      ...request,
      rigTaskId,
    };

    const taskId = await withRetry(
      () => this.provider.animateModel!(animRequest),
      this.retryConfig,
    );
    this.assertTaskId(taskId, "animateModel");

    const jobMetadata: JobMetadata = {
      jobId: this.generateJobId(),
      taskId,
      provider: this.provider.providerId,
      generationMode: GenerationModeEnum.Animation,
      prompt: `Animate: ${request.actionId}`,
      targetFormats: [],
      meshName: `anim-${taskId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    await this.trackJob(jobMetadata);
    return taskId;
  }

  /**
   * Gets the current status of a generation task.
   * Updates in-memory JobMetadata as it polls.
   *
   * @returns JobStatus with normalized state and raw provider response
   */
  async getJobStatus(taskId: string): Promise<JobStatus> {
    const status = await this.provider.getJobStatus(taskId);

    // Update local metadata if we're tracking this task
    const job = this.jobs.get(taskId);
    if (job) {
      job.state = (status.state as JobState) || JobState.Queued;
      job.progress = status.progress;
      if (status.state === JobState.Completed) {
        job.completedAt = new Date().toISOString();
      }
      if (status.taskError) {
        job.errorMessage = status.taskError.message;
        job.errorCode = status.taskError.code;
      }
      job.rawResponse = status.rawResponse;
      await this.persistJobUpdate(job);
    }

    return status;
  }

  /**
   * Cancels a generation task (best-effort).
   * Updates local metadata to reflect cancellation.
   */
  async cancelJob(taskId: string): Promise<void> {
    await this.provider.cancelJob(taskId);

    // Update local state
    const job = this.jobs.get(taskId);
    if (job) {
      job.state = JobState.Cancelled;
      job.completedAt = new Date().toISOString();
      await this.persistJobUpdate(job);
    }

    logger.info("Job cancelled", { taskId });
  }

  /**
   * Mirrors an updated JobMetadata to the job store, if configured.
   * Failures are logged, never thrown — the in-memory map remains authoritative.
   */
  private async persistJobUpdate(job: JobMetadata): Promise<void> {
    if (!this.jobStore) return;
    try {
      await this.jobStore.save(job);
    } catch (error) {
      logger.warn("Failed to persist job update to job store", {
        jobId: job.jobId,
        taskId: job.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Lists recent generation tasks (provider-dependent).
   * Filters to jobs tracked in local state (may not include tasks from other processes).
   *
   * @returns Array of task IDs from local in-memory state
   */
  listJobs(): string[] {
    return Array.from(this.jobs.keys());
  }

  /**
   * Retrieves metadata for a tracked job.
   * Returns undefined if the task is not in local state.
   */
  getJobMetadata(taskId: string): JobMetadata | undefined {
    return this.jobs.get(taskId);
  }

  /**
   * Generates a unique job ID.
   * Used to track related tasks (e.g., preview and refine are part of the same job).
   */
  private generateJobId(): string {
    return `job-${Date.now()}-${++this.nextJobIndex}`;
  }
}

/**
 * Singleton instance (will be instantiated by MCP server with real provider).
 * Exported for testing; production code should instantiate with a real IAI3DProvider.
 */
export let generationManager: GenerationManager | null = null;

/**
 * Initializes the global generation manager.
 * Called by the MCP server during startup.
 */
export function initGenerationManager(
  provider: IAI3DProvider,
  retryConfig?: Partial<BackoffConfig>,
  jobStore?: JobStoreInterface,
): GenerationManager {
  generationManager = new GenerationManager(provider, retryConfig, jobStore);
  return generationManager;
}
