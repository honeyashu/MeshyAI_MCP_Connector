/**
 * Meshy AI provider implementation.
 * Implements the IAI3DProvider interface for Meshy's 3D generation capabilities.
 *
 * Limitations and approximations documented in PLAN.md §2 are reflected in the capabilities object
 * and throughout the implementation.
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
  DownloadableAsset,
} from "../../core/IAI3DProvider.js";
import { AssetType, TextureType } from "../../core/types.js";
import type { ProviderCapabilities } from "../../core/types.js";
import {
  MeshyClient,
  type MeshyTextTo3DPreviewRequest,
  type MeshyTextTo3DRefineRequest,
  type MeshyImageTo3DRequest,
  type MeshyMultiImageTo3DRequest,
  type MeshyRiggingRequest,
  type MeshyAnimationRequest,
  type MeshyTaskResponse,
} from "./MeshyClient.js";
import { meshyStatusToJobState } from "./meshyMapping.js";
import {
  isValidActionId,
  getDefaultAnimationAction,
} from "./animationLibrary.js";
import { logger } from "../../core/Logger.js";

/**
 * Meshy AI provider capabilities.
 * Reflects the limitations documented in PLAN.md §2.
 */
const MESHY_CAPABILITIES: ProviderCapabilities = {
  // PLAN.md §2 item 1: negative_prompt is accepted but no-op on Meshy
  supportsNegativePrompt: true,

  // PLAN.md §2 item 2: .blend format not producible via API
  supportsBlendFormat: false,

  // PLAN.md §2 item 3: no turntable video output (only 4-view stills)
  supportsTurntableVideo: false,

  // PLAN.md §2 item 4: ZIP package built locally, not by Meshy
  supportsZipPackage: true,

  // PLAN.md §2 item 6: webhooks are account-wide dashboard config, not per-job
  supportsWebhooks: false,

  // Meshy supports rigging (humanoid only, ≤300k faces)
  supportsRigging: true,

  // Meshy supports animation with action IDs
  supportsAnimation: true,

  // Meshy supports texture refinement via the refine endpoint
  supportsTextureRefine: true,

  // Placeholder for future UV-related endpoints
  supportsRigiduv: false,

  // Meshy supports remesh endpoint
  supportsRemesh: true,

  // Meshy supports convert endpoint
  supportsConvert: true,

  // Meshy supports resize endpoint
  supportsResize: true,

  // Meshy supports retexture endpoint
  supportsRetexture: true,

  // Supported output formats (from PLAN.md §1 and types.ts)
  supportedFormats: [
    AssetType.GLB,
    AssetType.FBX,
    AssetType.OBJ,
    AssetType.MTL,
    AssetType.USDZ,
    AssetType.STL,
    AssetType.ThreeD,
    AssetType.PreRemeshedGLB,
  ],

  // Supported texture maps
  supportedTextureMaps: [
    TextureType.BaseColor,
    TextureType.Metallic,
    TextureType.Normal,
    TextureType.Roughness,
    TextureType.Emission,
  ],

  // Rate limits by tier (Pro tier defaults; can be overridden by config)
  rateLimitPerSecond: 20, // Pro tier: 20 req/s
  maxConcurrentJobs: 10, // Pro tier: 10 concurrent tasks
};

/**
 * Meshy AI provider.
 * Implements all IAI3DProvider methods using the typed MeshyClient.
 */
export class MeshyProvider implements IAI3DProvider {
  readonly providerId = "meshy";
  readonly capabilities: ProviderCapabilities = MESHY_CAPABILITIES;

  private client: MeshyClient;

  constructor(apiKey: string, timeoutMs?: number) {
    this.client = new MeshyClient(apiKey, timeoutMs);
  }

  /**
   * Text-to-3D preview generation (untextured mesh).
   * Returns the task ID for polling/status checks.
   */
  async textToPreview(request: TextToPreviewRequest): Promise<string> {
    const meshyRequest: MeshyTextTo3DPreviewRequest = {
      mode: "preview",
      prompt: request.prompt,
      negative_prompt: request.negativePrompt,
      model_type: request.modelType,
      ai_model: request.aiModel,
      should_remesh: request.shouldRemesh,
      topology: request.topology,
      target_polycount: request.targetPolycount,
      decimation_mode: request.decimationMode,
      pose_mode: request.poseMode,
      target_formats: request.targetFormats,
      auto_size: request.autoSize,
      origin_at: request.originAt,
      moderation: request.moderation,
      alpha_thumbnail: request.alphaThumbnail,
    };

    const response = await this.client.textTo3D(meshyRequest);
    return response.id;
  }

  /**
   * Text-to-3D refinement (texturing phase).
   * Requires a completed preview task ID.
   */
  async textToRefine(request: TextToRefineRequest): Promise<string> {
    const meshyRequest: MeshyTextTo3DRefineRequest = {
      mode: "refine",
      preview_task_id: request.previewTaskId,
      enable_pbr: request.enablePbr,
      hd_texture: request.hdTexture,
      texture_prompt: request.texturePrompt,
      texture_image_url: request.textureImageUrl,
      remove_lighting: request.removeLighting,
      target_formats: request.targetFormats,
      auto_size: request.autoSize,
      origin_at: request.originAt,
    };

    const response = await this.client.textTo3D(meshyRequest);
    return response.id;
  }

  /**
   * Image-to-3D generation.
   * Single image with optional texture refinement.
   */
  async imageToThreeD(request: ImageToThreeDRequest): Promise<string> {
    const meshyRequest: MeshyImageTo3DRequest = {
      image_url: request.imageUrl,
      input_task_id: request.inputTaskId,
      model_type: request.modelType,
      should_texture: request.shouldTexture,
      enable_pbr: request.enablePbr,
      hd_texture: request.hdTexture,
      texture_prompt: request.texturePrompt,
      texture_image_url: request.textureImageUrl,
      target_polycount: request.targetPolycount,
      target_formats: request.targetFormats,
      multi_view_thumbnails: request.multiViewThumbnails,
      auto_size: request.autoSize,
      origin_at: request.originAt,
      should_remesh: request.shouldRemesh,
      topology: request.topology,
      decimation_mode: request.decimationMode,
      save_pre_remeshed_model: request.savePreRemeshedModel,
      pose_mode: request.poseMode,
      image_enhancement: request.imageEnhancement,
      remove_lighting: request.removeLighting,
      moderation: request.moderation,
      alpha_thumbnail: request.alphaThumbnail,
    };

    const response = await this.client.imageTo3D(meshyRequest);
    return response.id;
  }

  /**
   * Multi-image-to-3D generation.
   * 1-4 images for better geometry reconstruction.
   */
  async multiImageToThreeD(
    request: MultiImageToThreeDRequest,
  ): Promise<string> {
    const meshyRequest: MeshyMultiImageTo3DRequest = {
      image_urls: request.imageUrls,
      model_type: request.modelType,
      should_texture: request.shouldTexture,
      enable_pbr: request.enablePbr,
      hd_texture: request.hdTexture,
      texture_prompt: request.texturePrompt,
      texture_image_url: request.textureImageUrl,
      target_polycount: request.targetPolycount,
      target_formats: request.targetFormats,
      multi_view_thumbnails: request.multiViewThumbnails,
      auto_size: request.autoSize,
      origin_at: request.originAt,
      should_remesh: request.shouldRemesh,
      topology: request.topology,
      decimation_mode: request.decimationMode,
      save_pre_remeshed_model: request.savePreRemeshedModel,
      pose_mode: request.poseMode,
      image_enhancement: request.imageEnhancement,
      remove_lighting: request.removeLighting,
      moderation: request.moderation,
      alpha_thumbnail: request.alphaThumbnail,
    };

    const response = await this.client.multiImageTo3D(meshyRequest);
    return response.id;
  }

  /**
   * Gets the current status of a task.
   * Normalizes Meshy's raw status to our JobState enum.
   */
  async getJobStatus(taskId: string): Promise<JobStatus> {
    // Attempt to fetch from text-to-3d; if that fails, try other endpoints
    let response: MeshyTaskResponse;
    try {
      response = await this.client.getTextTo3DTask(taskId);
    } catch {
      try {
        response = await this.client.getImageTo3DTask(taskId);
      } catch {
        try {
          response = await this.client.getMultiImageTo3DTask(taskId);
        } catch {
          try {
            response = await this.client.getRiggingTask(taskId);
          } catch {
            response = await this.client.getAnimationTask(taskId);
          }
        }
      }
    }

    const normalizedState = meshyStatusToJobState(response.status, response);

    return {
      taskId: response.id,
      state: normalizedState,
      rawState: response.status,
      progress: response.progress,
      modelUrls: response.model_urls,
      textureUrls: response.texture_urls,
      thumbnailUrl: response.thumbnail_url,
      thumbnailUrls: response.thumbnail_urls,
      estimatedTimeRemaining: undefined, // Meshy doesn't provide this
      taskError: response.task_error
        ? {
            type: response.task_error.type as
              | "invalid_input"
              | "timeout"
              | "service_unavailable"
              | "server_error"
              | "moderation_blocked",
            message: response.task_error.message,
            code: response.task_error.code,
            doc_url: response.task_error.doc_url,
          }
        : undefined,
      rawResponse: response,
    };
  }

  /**
   * Cancels a job (best-effort).
   * Meshy has no explicit cancel endpoint, so we call Delete.
   * See PLAN.md §2 item 7.
   */
  async cancelJob(taskId: string): Promise<void> {
    // Try to delete from text-to-3d; fallback to other endpoints
    try {
      await this.client.deleteTextTo3DTask(taskId);
    } catch {
      try {
        await this.client.deleteImageTo3DTask(taskId);
      } catch {
        try {
          await this.client.deleteMultiImageTo3DTask(taskId);
        } catch {
          try {
            await this.client.deleteRiggingTask(taskId);
          } catch {
            await this.client.deleteAnimationTask(taskId);
          }
        }
      }
    }
  }

  /**
   * Returns the downloadable asset URLs for a completed job (no actual file I/O).
   * Note: real download-to-disk logic now lives in `core/DownloadManager.ts` (Phase 6),
   * which consumes `JobStatus` directly rather than this method — see the design note
   * at the top of DownloadManager.ts. This method is kept for `IAI3DProvider` interface
   * completeness (e.g. a caller that only wants URLs, not files on disk) but
   * `outputDir` is intentionally unused here; it exists on the interface for providers
   * that might need it for provider-side packaging.
   */
  async downloadAssets(
    taskId: string,
    assetTypes: AssetType[],
    _outputDir: string,
  ): Promise<DownloadableAsset[]> {
    const status = await this.getJobStatus(taskId);

    if (!status.modelUrls) {
      return [];
    }

    const assets: DownloadableAsset[] = [];
    for (const assetType of assetTypes) {
      const url = status.modelUrls[assetType];
      if (url) {
        assets.push({
          assetType,
          url,
          filename: `model.${assetType}`,
        });
      }
    }

    // Texture maps
    if (status.textureUrls) {
      for (const textureType of [
        "base_color",
        "metallic",
        "normal",
        "roughness",
        "emission",
      ]) {
        const url = status.textureUrls[textureType];
        if (url) {
          assets.push({
            assetType: textureType as AssetType,
            url,
            filename: `${textureType}.png`,
          });
        }
      }
    }

    // Note: Actual download logic is implemented in Phase 6 (DownloadManager)
    return assets;
  }

  /**
   * Rigs a humanoid model for animation.
   * Only works on humanoid models ≤300k faces.
   */
  async rigModel(request: RiggingRequest): Promise<string> {
    const meshyRequest: MeshyRiggingRequest = {
      input_task_id: request.inputTaskId,
      model_url: request.modelUrl,
      height_meters: request.heightMeters,
    };

    const response = await this.client.rig(meshyRequest);
    return response.id;
  }

  /**
   * Animates a rigged model with a specific action.
   * Action ID must be valid (from animationLibrary).
   */
  async animateModel(request: AnimationRequest): Promise<string> {
    // Validate action ID
    if (!isValidActionId(request.actionId)) {
      const fallback = getDefaultAnimationAction().id;
      logger.warn(
        `Action ID '${request.actionId}' not found in animation library; defaulting to '${fallback}'`,
        {
          requestedActionId: request.actionId,
          fallbackActionId: fallback,
        },
      );
      request.actionId = fallback;
    }

    const meshyRequest: MeshyAnimationRequest = {
      rig_task_id: request.rigTaskId,
      action_id: request.actionId,
      post_process: request.postProcess
        ? {
            change_fps: request.postProcess.changeFps,
            fbx2usdz: request.postProcess.fbx2usdz,
            extract_armature: request.postProcess.extractArmature,
          }
        : undefined,
    };

    const response = await this.client.animate(meshyRequest);
    return response.id;
  }

  /**
   * Gets account balance/credits.
   */
  async getBalance(): Promise<number> {
    return await this.client.getBalance();
  }

  /**
   * Tests connection to the Meshy API.
   * Throws if connection fails.
   */
  async testConnection(): Promise<void> {
    try {
      const balance = await this.getBalance();
      // Success; balance is returned but we just need to know the connection works
      if (balance === undefined) {
        throw new Error("Invalid balance response");
      }
    } catch (error) {
      throw new Error(`Failed to connect to Meshy API: ${error}`);
    }
  }
}
