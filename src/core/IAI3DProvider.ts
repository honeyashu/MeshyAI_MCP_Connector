/**
 * Provider-agnostic 3D generation interface.
 * All providers (Meshy, Tripo, Rodin, Luma, Trellis, etc.) implement this contract.
 * Allows swapping providers without changing business logic.
 */

import type { AssetType, ProviderCapabilities } from "./types.js";

/**
 * Request parameters for text-to-3D generation (preview phase).
 */
export interface TextToPreviewRequest {
  prompt: string;
  negativePrompt?: string;
  modelType?: string;
  aiModel?: string;
  shouldRemesh?: boolean;
  topology?: string;
  targetPolycount?: number;
  decimationMode?: string;
  poseMode?: string;
  targetFormats?: AssetType[];
  autoSize?: boolean;
  originAt?: string;
  moderation?: boolean;
  alphaThumbnail?: boolean;
}

/**
 * Request parameters for text-to-3D refinement (texturing phase).
 */
export interface TextToRefineRequest {
  previewTaskId: string;
  enablePbr?: boolean;
  hdTexture?: boolean;
  texturePrompt?: string;
  textureImageUrl?: string;
  removeLighting?: boolean;
  targetFormats?: AssetType[];
  autoSize?: boolean;
  originAt?: string;
}

/**
 * Request parameters for image-to-3D generation.
 */
export interface ImageToThreeDRequest {
  imageUrl?: string;
  inputTaskId?: string;
  modelType?: string;
  shouldTexture?: boolean;
  enablePbr?: boolean;
  hdTexture?: boolean;
  texturePrompt?: string;
  textureImageUrl?: string;
  targetPolycount?: number;
  targetFormats?: AssetType[];
  multiViewThumbnails?: boolean;
  autoSize?: boolean;
  originAt?: string;
  shouldRemesh?: boolean;
  topology?: string;
  decimationMode?: string;
  savePreRemeshedModel?: boolean;
  poseMode?: string;
  imageEnhancement?: boolean;
  removeLighting?: boolean;
  moderation?: boolean;
  alphaThumbnail?: boolean;
}

/**
 * Request parameters for multi-image-to-3D generation.
 */
export interface MultiImageToThreeDRequest {
  imageUrls: string[]; // 1-4 images
  modelType?: string;
  shouldTexture?: boolean;
  enablePbr?: boolean;
  hdTexture?: boolean;
  texturePrompt?: string;
  textureImageUrl?: string;
  targetPolycount?: number;
  targetFormats?: AssetType[];
  multiViewThumbnails?: boolean;
  autoSize?: boolean;
  originAt?: string;
  shouldRemesh?: boolean;
  topology?: string;
  decimationMode?: string;
  savePreRemeshedModel?: boolean;
  poseMode?: string;
  imageEnhancement?: boolean;
  removeLighting?: boolean;
  moderation?: boolean;
  alphaThumbnail?: boolean;
}

/**
 * Request parameters for rigging a generated model.
 */
export interface RiggingRequest {
  inputTaskId?: string;
  modelUrl?: string;
  heightMeters?: number;
}

/**
 * Request parameters for animating a rigged model.
 */
export interface AnimationRequest {
  rigTaskId: string;
  actionId: string;
  postProcess?: {
    changeFps?: number;
    fbx2usdz?: boolean;
    extractArmature?: boolean;
  };
}

/**
 * Job status response from a provider.
 */
export interface JobStatus {
  taskId: string;
  state: string; // Normalized status (our common JobState enum as string), e.g., 'Processing', 'Completed'
  rawState?: string; // Provider-specific status (e.g., Meshy's 'PENDING', 'IN_PROGRESS') for reference
  progress: number; // 0-100
  modelUrls?: Record<string, string>; // format -> URL mapping (e.g., { glb: '...', fbx: '...' })
  textureUrls?: Record<string, string>; // map type -> URL mapping
  thumbnailUrl?: string;
  thumbnailUrls?: Record<string, string>; // view -> URL mapping (front, right, back, left)
  estimatedTimeRemaining?: number; // seconds
  taskError?: {
    type:
      | "invalid_input"
      | "timeout"
      | "service_unavailable"
      | "server_error"
      | "moderation_blocked";
    message: string;
    code?: string;
    doc_url?: string;
  };
  rawResponse?: Record<string, unknown>; // raw provider response
}

/**
 * Asset download info.
 */
export interface DownloadableAsset {
  assetType: AssetType;
  url: string;
  filename: string;
}

/**
 * Provider-agnostic 3D generation contract.
 * All implementations must provide these methods.
 */
export interface IAI3DProvider {
  /**
   * Provider identifier (e.g., 'meshy', 'tripo', 'luma').
   */
  readonly providerId: string;

  /**
   * Provider capabilities descriptor.
   * Reports what the provider supports vs. what is deprecated/unsupported.
   */
  readonly capabilities: ProviderCapabilities;

  /**
   * Generates a 3D model from a text prompt (preview phase).
   * Returns the task ID for polling/status checks.
   */
  textToPreview(request: TextToPreviewRequest): Promise<string>;

  /**
   * Refines a text-to-3D preview with texturing and/or format changes.
   * Returns the task ID for polling/status checks.
   */
  textToRefine(request: TextToRefineRequest): Promise<string>;

  /**
   * Generates a 3D model from a single image.
   * Returns the task ID for polling/status checks.
   */
  imageToThreeD(request: ImageToThreeDRequest): Promise<string>;

  /**
   * Generates a 3D model from multiple images (1-4).
   * Returns the task ID for polling/status checks.
   */
  multiImageToThreeD(request: MultiImageToThreeDRequest): Promise<string>;

  /**
   * Gets the current status of a generation task.
   */
  getJobStatus(taskId: string): Promise<JobStatus>;

  /**
   * Lists recent/queued generation tasks (optional, provider-dependent).
   * @param limit Maximum number of tasks to return.
   * @returns Array of task IDs.
   */
  listJobs?(limit?: number): Promise<string[]>;

  /**
   * Cancels a generation task.
   * Best-effort; some providers may not support true cancellation.
   */
  cancelJob(taskId: string): Promise<void>;

  /**
   * Downloads assets for a completed job.
   * @param taskId Task ID.
   * @param assetTypes Types of assets to download.
   * @param outputDir Directory to save assets.
   * @returns Array of downloaded asset info.
   */
  downloadAssets(
    taskId: string,
    assetTypes: AssetType[],
    outputDir: string,
  ): Promise<DownloadableAsset[]>;

  /**
   * Rigs a humanoid model for animation.
   * Only applicable for models that support rigging.
   */
  rigModel?(request: RiggingRequest): Promise<string>;

  /**
   * Animates a rigged model with a specific action.
   * Requires a valid action ID from the provider's action library.
   */
  animateModel?(request: AnimationRequest): Promise<string>;

  /**
   * Gets account balance/credits.
   */
  getBalance(): Promise<number>;

  /**
   * Tests connection to the provider API.
   * Throws or returns an error object if connection fails.
   */
  testConnection(): Promise<void>;
}
