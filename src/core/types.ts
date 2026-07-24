/**
 * Shared enums and interfaces across all providers.
 * These are provider-agnostic types that the IAI3DProvider interface works with.
 */

/**
 * Normalized job state across all providers.
 * Maps provider-specific statuses (e.g., Meshy's PENDING/IN_PROGRESS) to this common enum.
 */
export enum JobState {
  Queued = "Queued",
  Processing = "Processing",
  Texturing = "Texturing",
  Meshing = "Meshing",
  Completed = "Completed",
  Failed = "Failed",
  Cancelled = "Cancelled",
}

/**
 * Connection status for credential validation and provider health checks.
 */
export enum ConnectionStatus {
  Connected = "Connected",
  Unauthorized = "Unauthorized",
  QuotaExceeded = "QuotaExceeded",
  InvalidKey = "InvalidKey",
  NetworkError = "NetworkError",
  RateLimitExceeded = "RateLimitExceeded",
  NoMoreConcurrentTasks = "NoMoreConcurrentTasks",
  UnknownError = "UnknownError",
}

/**
 * Asset types that can be downloaded from a 3D generation job.
 */
export enum AssetType {
  GLB = "glb",
  FBX = "fbx",
  OBJ = "obj",
  MTL = "mtl",
  USDZ = "usdz",
  STL = "stl",
  ThreeD = "3mf",
  PreRemeshedGLB = "pre_remeshed_glb",
}

/**
 * Texture map types that can be extracted from models.
 */
export enum TextureType {
  BaseColor = "base_color",
  Metallic = "metallic",
  Normal = "normal",
  Roughness = "roughness",
  Emission = "emission",
}

/**
 * Generation modes supported by providers.
 */
export enum GenerationMode {
  TextToPreview = "text-to-preview",
  TextToRefine = "text-to-refine",
  ImageToThreeD = "image-to-3d",
  MultiImageToThreeD = "multi-image-to-3d",
  Rigging = "rigging",
  Animation = "animation",
}

/**
 * Provider-specific capabilities descriptor.
 * Used to expose what a provider actually supports vs. what is deprecated/unsupported.
 */
export interface ProviderCapabilities {
  supportsNegativePrompt: boolean;
  supportsBlendFormat: boolean;
  supportsTurntableVideo: boolean;
  supportsZipPackage: boolean;
  supportsWebhooks: boolean;
  supportsRigging: boolean;
  supportsAnimation: boolean;
  supportsTextureRefine: boolean;
  supportsRigiduv: boolean;
  supportsRemesh: boolean;
  supportsConvert: boolean;
  supportsResize: boolean;
  supportsRetexture: boolean;
  supportedFormats: AssetType[];
  supportedTextureMaps: TextureType[];
  rateLimitPerSecond: number;
  maxConcurrentJobs: number;
}

/**
 * Job metadata stored locally.
 * Tracks credential, request params, status, and completion details.
 */
export interface JobMetadata {
  jobId: string;
  taskId: string; // provider-specific task ID (e.g., Meshy task_id)
  provider: string; // e.g., 'meshy'
  generationMode: GenerationMode;
  prompt: string;
  negativePrompt?: string;
  modelType?: string;
  targetFormats: AssetType[];
  meshName: string;
  createdAt: string; // ISO 8601
  startedAt?: string;
  completedAt?: string;
  state: JobState;
  progress: number; // 0-100
  errorMessage?: string;
  errorCode?: string;
  consumedCredits?: number;
  downloadPath?: string;
  downloadedAssets: AssetType[];
  rawResponse?: Record<string, unknown>;
}

/**
 * Credentials store interface.
 * Implementations handle encryption/decryption at rest.
 */
export interface CredentialStoreInterface {
  save(providerId: string, key: string): Promise<void>;
  load(providerId: string): Promise<string | null>;
  delete(providerId: string): Promise<void>;
  exists(providerId: string): Promise<boolean>;
}

/**
 * Job persistence store interface.
 * GenerationManager accepts an optional implementation of this (see store/jobStore.ts,
 * Phase 6) to persist JobMetadata beyond the in-memory Map. If no store is provided,
 * GenerationManager falls back to in-memory-only tracking (state lost on process restart).
 */
export interface JobStoreInterface {
  save(job: JobMetadata): Promise<void>;
  get(taskId: string): Promise<JobMetadata | undefined>;
  list(filter?: {
    provider?: string;
    state?: JobState;
  }): Promise<JobMetadata[]>;
  delete(taskId: string): Promise<void>;
}

/**
 * Generic error response from provider APIs.
 */
export interface ProviderError {
  httpStatus: number;
  message: string;
  code?: string;
  taskError?: {
    // 'moderation_blocked' added here (was missing from the original union despite
    // PLAN.md §6 documenting it as a real fail-fast case, and RetryPolicy.isTransientError()
    // already handling it correctly) — caught by the first real `tsc` run in Phase 9.
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
}

/**
 * Logging level configuration.
 */
export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

/**
 * Configuration for the connector.
 * All settings are overridable and none are hardcoded into logic.
 */
export interface ConnectorConfig {
  downloadDirectory: string;
  defaultProvider: string;
  retryCount: number;
  timeoutMs: number;
  parallelDownloads: number;
  autoDownload: boolean;
  overwriteExisting: boolean;
  enableLogging: boolean;
  logLevel: LogLevel;
  maxConcurrentJobs: number;
  tier: "pro" | "studio" | "enterprise";
}

/**
 * Test connection result.
 */
export interface TestConnectionResult {
  status: ConnectionStatus;
  balance?: number;
  message?: string;
}
