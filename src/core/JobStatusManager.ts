/**
 * Job status tracking: SSE-first with polling fallback, normalized progress events.
 *
 * Per original spec §8 (Progress Tracking): "Provide progress callbacks/events... include
 * stage descriptions where available." This is implemented via Node's EventEmitter (the
 * natural fit for a Node/MCP server — WinForms/WPF/MVVM event binding from the original
 * spec doesn't apply here, see PLAN.md §0), emitting:
 *   - 'progress' (taskId, progress 0-100, JobState, phase description)
 *   - 'completed' (taskId, final JobStatus)
 *   - 'failed' (taskId, JobStatus with taskError)
 *   - 'cancelled' (taskId)
 *
 * SSE (Server-Sent Events) is preferred when the provider's client exposes a stream
 * (MeshyClient.streamTaskStatus, Phase 4/8), since it avoids polling overhead against
 * Meshy's per-tier rate limits (PLAN.md §1). If SSE isn't available or the stream drops,
 * falls back to polling `provider.getJobStatus()` at a configurable interval.
 */

import { EventEmitter } from "events";
import type { IAI3DProvider, JobStatus } from "./IAI3DProvider.js";
import { JobState } from "./types.js";
import { logger } from "./Logger.js";
import { getPhaseDescription } from "./jobStateUtils.js";

export interface JobStatusManagerConfig {
  /** Polling interval in ms, used when SSE is unavailable or as a fallback. */
  pollIntervalMs: number;
  /** Max time to track a single job before giving up (ms). */
  maxTrackingDurationMs: number;
}

export const DEFAULT_JOB_STATUS_CONFIG: JobStatusManagerConfig = {
  pollIntervalMs: 5000,
  maxTrackingDurationMs: 30 * 60 * 1000, // 30 minutes
};

interface TrackedJob {
  taskId: string;
  timer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
  startedAt: number;
  usingSse: boolean;
}

/**
 * A minimal SSE line-parser for Meshy's event stream format:
 *   event: message
 *   data: {"id": "...", "progress": 50, "status": "IN_PROGRESS"}
 *
 *   event: error
 *   data: {"status_code": 404, "message": "Task not found"}
 *
 * Yields parsed `{ event, data }` frames as they arrive.
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? ""; // keep the last (possibly incomplete) frame

      for (const frame of frames) {
        let event = "message";
        let dataLine = "";

        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice("event:".length).trim();
          } else if (line.startsWith("data:")) {
            dataLine += line.slice("data:".length).trim();
          }
        }

        if (dataLine) {
          try {
            yield { event, data: JSON.parse(dataLine) };
          } catch {
            // Malformed frame — skip it, don't crash the stream.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Tracks generation job status via SSE (preferred) or polling (fallback),
 * emitting normalized progress/completed/failed/cancelled events.
 */
export class JobStatusManager extends EventEmitter {
  private tracked = new Map<string, TrackedJob>();

  constructor(
    private provider: IAI3DProvider,
    private config: JobStatusManagerConfig = DEFAULT_JOB_STATUS_CONFIG,
    /**
     * Optional SSE opener. Only MeshyProvider-backed setups can supply this today
     * (via MeshyClient.streamTaskStatus + MeshyClient.buildStreamPath) — providers
     * without SSE support simply omit it and JobStatusManager polls instead.
     */
    private openStream?: (
      taskId: string,
      signal: AbortSignal,
    ) => Promise<Response>,
  ) {
    super();
  }

  /**
   * Starts tracking a task. Emits events as its status changes; stops automatically
   * on completion, failure, cancellation, or maxTrackingDurationMs elapsing.
   */
  track(taskId: string): void {
    if (this.tracked.has(taskId)) {
      logger.debug(`Already tracking task ${taskId}`);
      return;
    }

    const job: TrackedJob = { taskId, startedAt: Date.now(), usingSse: false };
    this.tracked.set(taskId, job);

    if (this.openStream) {
      this.trackViaSse(job).catch((error) => {
        logger.warn(
          `SSE tracking failed for ${taskId}, falling back to polling`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        this.trackViaPolling(job);
      });
    } else {
      this.trackViaPolling(job);
    }
  }

  /**
   * Stops tracking a task (does not cancel the underlying generation — see
   * GenerationManager.cancelJob for that).
   */
  stop(taskId: string): void {
    const job = this.tracked.get(taskId);
    if (!job) return;

    if (job.timer) clearTimeout(job.timer);
    if (job.abortController) job.abortController.abort();

    this.tracked.delete(taskId);
  }

  private async trackViaSse(job: TrackedJob): Promise<void> {
    if (!this.openStream) return;

    job.abortController = new AbortController();
    job.usingSse = true;

    const response = await this.openStream(
      job.taskId,
      job.abortController.signal,
    );
    if (!response.body) {
      throw new Error("SSE response has no body");
    }

    // Deliberate design choice: the SSE frame's raw `data` payload is provider-specific
    // (Meshy's wire format uses snake_case keys like `model_urls`/`status`, different
    // from our normalized JobStatus shape) and JobStatusManager must stay provider-agnostic
    // (see file header). Rather than hand-parsing provider-specific fields here — which
    // would either duplicate meshyMapping.ts's normalization logic in core/, or silently
    // misread fields (an earlier draft of this method did exactly that) — each SSE frame
    // is treated purely as a low-latency "wake up and check now" signal. The actual
    // JobStatus is always fetched via the already-correct, already-reviewed
    // `provider.getJobStatus()` polling path. This trades a small amount of extra latency
    // (one HTTP round trip per SSE frame) for correctness and provider-agnosticism; a
    // future optimization could add a provider-supplied normalizer callback if that
    // round trip proves too costly in practice.
    for await (const frame of parseSseStream(response.body)) {
      if (!this.tracked.has(job.taskId)) return; // stopped externally

      if (frame.event === "error") {
        const data = frame.data as { status_code?: number; message?: string };
        logger.warn(
          `SSE stream error for ${job.taskId}: ${data.message ?? "unknown"}`,
        );
        // Fall back to polling rather than giving up entirely.
        this.trackViaPolling(job);
        return;
      }

      let status: JobStatus;
      try {
        status = await this.provider.getJobStatus(job.taskId);
      } catch (error) {
        logger.warn(
          `Failed to fetch status after SSE signal for ${job.taskId}`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        continue;
      }

      this.emitProgress(job.taskId, status);

      if (this.isTerminalState(status.state)) {
        this.stop(job.taskId);
        return;
      }
    }

    // Stream ended without a terminal state — fall back to polling to be safe.
    if (this.tracked.has(job.taskId)) {
      this.trackViaPolling(job);
    }
  }

  private trackViaPolling(job: TrackedJob): void {
    job.usingSse = false;

    const poll = async (): Promise<void> => {
      if (!this.tracked.has(job.taskId)) return;

      if (Date.now() - job.startedAt > this.config.maxTrackingDurationMs) {
        logger.warn(
          `Gave up tracking ${job.taskId} after exceeding maxTrackingDurationMs`,
        );
        this.emit("failed", job.taskId, {
          taskId: job.taskId,
          state: JobState.Failed,
          progress: 0,
          taskError: {
            type: "timeout",
            message: "Exceeded maximum tracking duration",
          },
        } as JobStatus);
        this.stop(job.taskId);
        return;
      }

      try {
        const status = await this.provider.getJobStatus(job.taskId);
        this.emitProgress(job.taskId, status);

        if (this.isTerminalState(status.state)) {
          this.stop(job.taskId);
          return;
        }
      } catch (error) {
        logger.warn(
          `Polling failed for ${job.taskId}, will retry on next interval`,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }

      if (this.tracked.has(job.taskId)) {
        job.timer = setTimeout(() => void poll(), this.config.pollIntervalMs);
      }
    };

    void poll();
  }

  private isTerminalState(state: string | undefined): boolean {
    return (
      state === JobState.Completed ||
      state === JobState.Failed ||
      state === JobState.Cancelled ||
      state === "SUCCEEDED" ||
      state === "FAILED" ||
      state === "CANCELED"
    );
  }

  private emitProgress(taskId: string, status: JobStatus): void {
    const phaseDescription = getPhaseDescription(status.state as JobState);

    this.emit(
      "progress",
      taskId,
      status.progress,
      status.state,
      phaseDescription,
    );

    if (status.state === JobState.Completed || status.state === "SUCCEEDED") {
      this.emit("completed", taskId, status);
    } else if (status.state === JobState.Failed || status.state === "FAILED") {
      this.emit("failed", taskId, status);
    } else if (
      status.state === JobState.Cancelled ||
      status.state === "CANCELED"
    ) {
      this.emit("cancelled", taskId, status);
    }
  }
}
