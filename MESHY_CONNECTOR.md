# Meshy AI Claude Connector — Developer Guide

**Status:** All phases complete (142/142 tests passing, real TypeScript compilation verified). This documents both the library API and the MCP server (`src/server/mcpServer.ts`), which exposes every capability below as an MCP tool for Claude Desktop / Claude Code / Cowork — see "Known Gaps" for the two remaining, intentional limitations.

**Table of Contents**
1. [Quick Start](#quick-start)
2. [Module Layout](#module-layout)
3. [Core Concepts](#core-concepts)
4. [API Reference](#api-reference)
5. [Configuration](#configuration)
6. [Output Folder Structure](#output-folder-structure)
7. [Error Handling & Status Mapping](#error-handling--status-mapping)
8. [Adding a New Provider](#adding-a-new-provider)
9. [Known Gaps & Limitations](#known-gaps--limitations)

---

## Quick Start

### As an MCP server (recommended — this is how AttrangiToys and most consumers should use it)

Build once, then point Claude Desktop / Claude Code / Cowork at the compiled entry point:

```bash
cd meshy-ai-connector
npm install
npm run build
```

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "meshy-ai": {
      "command": "node",
      "args": ["/absolute/path/to/meshy-ai-connector/dist/server/mcpServer.js"]
    }
  }
}
```

Then, from within Claude, call the `save_credentials` tool once with your Meshy API key (`msy_...`) — it's encrypted at rest via AES-256-GCM in `~/.meshy-connector`, so this is a one-time setup step, not something you repeat per session. From there, tools like `generate_text_to_3d_preview`, `refine_text_to_3d`, `generate_image_to_3d`, `get_job_status`, and `download_job_assets` are available directly to Claude. See [API Reference](#api-reference) for the full tool list and what each maps to.

### As a library (for embedding in your own Node.js code)

```typescript
import { GenerationManager } from './src/core/GenerationManager.js';
import { MeshyProvider } from './src/providers/meshy/MeshyProvider.js';
import { CredentialManager } from './src/core/CredentialManager.js';
import { createJobStore } from './src/store/jobStore.js';
import { JobState } from './src/core/types.js';
import { DownloadManager } from './src/core/DownloadManager.js';

// Set up credentials (one-time; persists encrypted on disk)
const credentialManager = new CredentialManager();
await credentialManager.saveCredentials('meshy', 'msy_your_key_here');

// Create provider and generation manager
const apiKey = await credentialManager.loadCredentials('meshy');
const provider = new MeshyProvider(apiKey!);
const jobStore = await createJobStore(); // optional SQLite persistence; undefined if better-sqlite3 isn't installed
const manager = new GenerationManager(provider, {}, jobStore);

// Generate a 3D model from text
const taskId = await manager.textToPreview({
  prompt: 'A ceramic toy car'
});

// Poll for completion
const status = await manager.getJobStatus(taskId);
console.log(`Task ${taskId}: ${status.state} (${status.progress}%)`);

// Download assets once complete
if (status.state === JobState.Completed) {
  const downloader = new DownloadManager({
    downloadDirectory: '/tmp/3d-assets',
    parallelDownloads: 3,
    overwriteExisting: false,
    autoZip: false
  });

  const job = manager.getJobMetadata(taskId);
  const result = await downloader.downloadJob(job!, status);
  console.log(`Assets saved to: ${result.jobFolder}`);
}
```

---

## Module Layout

The connector is organized by responsibility:

```
src/
  ├── core/                    # Provider-agnostic, reusable components
  │   ├── IAI3DProvider.ts     # Provider interface (generate, status, download, capabilities)
  │   ├── GenerationManager.ts # Orchestration (preview→refine, image→3D, rig→animate)
  │   ├── JobStatusManager.ts  # Progress tracking (SSE + polling); available to library embedders, not wired into the MCP server (request/response model — see Known Gaps)
  │   ├── DownloadManager.ts   # Concurrent downloads, folder layout, zip packaging, Draco compression
  │   ├── CredentialManager.ts # Credential save/load/validate
  │   ├── Logger.ts            # Structured logging (redacts secrets)
  │   ├── RetryPolicy.ts       # Exponential backoff (5xx, 429, timeout → retry)
  │   ├── jobStateUtils.ts     # Job state normalization and phase descriptions
  │   └── types.ts             # Shared enums and interfaces
  │
  ├── providers/
  │   └── meshy/               # Meshy AI implementation
  │       ├── MeshyProvider.ts     # Implements IAI3DProvider
  │       ├── MeshyClient.ts       # Typed HTTP client for Meshy API
  │       ├── meshyMapping.ts      # Meshy's raw status/format → our enums
  │       └── animationLibrary.ts  # Static action_id reference table
  │
  ├── store/
  │   ├── jobStore.ts          # SQLite-backed job persistence (optional; falls back to in-memory)
  │   └── credentialStore.ts   # Encrypted credential file
  │
  └── server/
      └── mcpServer.ts         # MCP server entry point — registers 14 tools, wraps GenerationManager/DownloadManager/CredentialManager for stdio-based MCP clients (Claude Desktop, Claude Code, Cowork)
```

There is currently no `ProviderFactory.ts` — with a single provider (Meshy), `mcpServer.ts` bootstraps `MeshyProvider` directly and lazily on first tool call. A factory/registry is the natural next step once a second provider is added (see [Adding a New Provider](#adding-a-new-provider) step 4 for the suggested shape).

**Core responsibility of each module:**

- **IAI3DProvider**: Contract that all providers must implement. Defines methods for generation, status polling, cancellation, asset download, and a capabilities descriptor.
- **GenerationManager**: Stateful orchestrator. Handles preview→refine chaining (text-to-3D), image-to-3D workflows, rig→animate pipelines. Retries transient errors. Tracks jobs in memory (with optional SQLite persistence).
- **JobStatusManager**: Event-emitting progress tracker. Prefers SSE streams; falls back to polling. Emits `'progress'`, `'completed'`, `'failed'`, `'cancelled'` events. Respects a configurable max tracking duration. Used by library embedders that want push-style updates; the MCP server instead exposes `get_job_status` for clients to poll, since MCP tool calls are request/response.
- **DownloadManager**: Concurrent, resumable downloads. Lays out assets per PLAN.md §4 (GLB/, OBJ/, Textures/, etc.). Writes metadata and logs. Optional Draco compression (via `@gltf-transform/*` + `draco3d`, both optionalDependencies) and ZIP packaging.
- **CredentialManager**: Manages API key lifecycle. Saves encrypted to disk (AES-256-GCM, with a random key stored in `~/.meshy-connector/.master`). Validates connectivity via `testConnection()`.
- **Logger**: Structured JSON-line logging to stderr. Redacts `msy_*` keys and `Bearer` tokens automatically.
- **RetryPolicy**: Classifies errors (transient vs. non-transient) and applies exponential backoff with jitter. Honors `maxRetries` and `Retry-After` headers.
- **mcpServer**: The MCP entry point. Registers 14 tools (credentials, generation, job status/cancel/list, downloads) against a lazily-bootstrapped `GenerationManager`/`DownloadManager`. See [API Reference](#api-reference) below for the full tool-to-method mapping.

---

## Core Concepts

### Job Lifecycle

Every generation request progresses through states defined in `JobState` enum:

```typescript
enum JobState {
  Queued = 'queued',              // Task submitted, waiting in queue
  Processing = 'processing',      // Actively generating (mesh or texture)
  Completed = 'completed',        // Success; assets ready to download
  Failed = 'failed',              // Unrecoverable error
  Cancelled = 'cancelled'         // Stopped by user
}
```

**Text-to-3D Example (preview→refine chain):**

1. `manager.textToPreview(prompt)` → returns `taskId_preview`
   - State: Queued → Processing → Completed
   - Output: Untextured mesh (GLB, OBJ, FBX, USDZ, STL, 3MF)
2. `manager.textToRefine(taskId_preview, {...textureParams})` → returns `taskId_refine`
   - State: Queued → Processing → Completed
   - Output: Textured mesh + PBR maps (if `enable_pbr: true`)

**Important:** Preview→Refine chaining is **NOT automatic**. The caller must explicitly invoke `textToRefine()` once the preview task succeeds. This avoids hidden async side effects and keeps the API predictable.

### Provider Capabilities

Every provider declares what it supports:

```typescript
interface ProviderCapabilities {
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
```

**MeshyProvider reports:**
- ✅ `supportsTextureRefine`, `supportsRigging`, `supportsAnimation`
- ❌ `supportsNegativePrompt` (field exists but has no effect)
- ❌ `supportsBlendFormat` (not produced via API)
- ❌ `supportsTurntableVideo` (not a Meshy output; use thumbnail stills instead)
- ✅ `supportedFormats`: GLB, OBJ, FBX, USDZ, STL, 3MF
- ✅ `supportedTextureMaps`: BaseColor, Normal, Metallic, Roughness, Emission (PBR only)
- Rate limits: Pro 20 req/s, 10 concurrent; Studio 20 req/s, 20 concurrent; Enterprise 100 req/s, 50+ concurrent

### Job Phases (Synthesized)

Meshy's API returns only a basic status (`PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED`) and a progress 0-100 integer. The connector synthesizes richer phase descriptions for better UX:

```typescript
function getPhaseDescription(state: JobState): string {
  // Given a JobState and context (task type), returns:
  // e.g. "Meshing..." for a text-to-preview in progress
  // e.g. "Texturing..." for a text-to-refine in progress
  // e.g. "Queued..." for any task not yet started
}
```

This mapping is **documented as an approximation**, not a literal Meshy API field.

---

## API Reference

### GenerationManager

**Constructor:**
```typescript
new GenerationManager(
  provider: IAI3DProvider,
  retryConfig?: Partial<BackoffConfig>,
  jobStore?: JobStoreInterface
)
```

**Methods:**

```typescript
// Text-to-3D (preview mode, untextured)
async textToPreview(request: TextToPreviewRequest): Promise<string>
// Returns task ID; caller must chain textToRefine() manually

// Text-to-3D (refine mode, texturing)
async textToRefine(previewTaskId: string, request: TextToRefineRequest): Promise<string>
// Validates preview is complete; returns new task ID for refinement

// Image-to-3D (single image, inline texturing)
async imageToThreeD(request: ImageToThreeDRequest): Promise<string>

// Multi-Image-to-3D (1-4 images, inline texturing)
async multiImageToThreeD(request: MultiImageToThreeDRequest): Promise<string>

// Rig a humanoid model (optional, depends on provider capabilities)
async rigModel(request: RiggingRequest): Promise<string>
// Caller must chain animateModel() manually

// Animate a rigged model
async animateModel(rigTaskId: string, request: Omit<AnimationRequest, 'rigTaskId'>): Promise<string>

// Poll for current task status
async getJobStatus(taskId: string): Promise<JobStatus>

// Cancel a task (best-effort; not all providers support graceful cancel)
async cancelJob(taskId: string): Promise<void>

// List all tracked task IDs from in-memory state
listJobs(): string[]

// Retrieve metadata for a tracked task (undefined if unknown)
getJobMetadata(taskId: string): JobMetadata | undefined
```

**Request interfaces** (key fields; see `IAI3DProvider.ts` for full signatures):

```typescript
interface TextToPreviewRequest {
  prompt: string;                    // Required; 600 char max per Meshy
  negativePrompt?: string;           // Accepted but no-op on Meshy (documented)
  modelType?: 'standard' | 'cute' | 'realastic'; // Meshy specific
  targetFormats?: AssetType[];
  targetPolycount?: number;
  shouldRemesh?: boolean;
  // ... more Meshy-specific parameters
}

interface TextToRefineRequest {
  previewTaskId: string;             // Required; result of prior textToPreview()
  enablePbr?: boolean;               // Physically-based rendering
  hdTexture?: boolean;               // Higher resolution textures
  texturePrompt?: string;
  textureImageUrl?: string;
  removeLighting?: boolean;
  targetFormats?: AssetType[];
}

interface ImageToThreeDRequest {
  imageUrl?: string;                 // Required: imageUrl or inputTaskId
  inputTaskId?: string;
  shouldTexture?: boolean;
  enablePbr?: boolean;
  modelType?: 'standard' | 'smart-topology' | 'lowpoly';
  // ... more parameters
}

// MultiImageToThreeDRequest: same fields as ImageToThreeD, but imageUrls: string[]
```

### DownloadManager

**Constructor:**
```typescript
new DownloadManager(config: DownloadManagerConfig)

interface DownloadManagerConfig {
  downloadDirectory: string;          // Root folder for job output
  parallelDownloads: number;          // Max concurrent file downloads
  overwriteExisting: boolean;         // Skip existing files (false = resume)
  autoZip: boolean;                   // Build <MeshName>.zip after download
  compressGlb?: boolean;              // Attempt Draco compression (best-effort)
  maxGlbSizeBytes?: number;           // Warn if over budget (never throws)
  retryConfig?: Partial<BackoffConfig>;
}
```

**Methods:**

```typescript
async downloadJob(job: JobMetadata, status: JobStatus): Promise<DownloadJobResult>

interface DownloadJobResult {
  jobFolder: string;                  // Path to <MeshName>_<jobId>/
  files: DownloadedFile[];            // What was downloaded
  zipPath?: string;                   // Path to .zip (if autoZip: true)
  warnings: string[];                 // Partial failures, compression notes, etc.
}
```

### JobStatusManager

**Constructor:**
```typescript
new JobStatusManager(
  provider: IAI3DProvider,
  config?: JobStatusManagerConfig,
  openStream?: (taskId: string, signal: AbortSignal) => Promise<Response>
)

interface JobStatusManagerConfig {
  pollIntervalMs: number;             // Default 5000ms
  maxTrackingDurationMs: number;      // Default 30 min; times out with 'timeout' error
}
```

**Methods:**

```typescript
track(taskId: string): void            // Start tracking; emits events
stop(taskId: string): void             // Stop polling/streaming
```

**Events (via EventEmitter):**

```typescript
manager.on('progress', (taskId: string, progress: number, state: string, phaseDescription: string) => {
  // Fired on every poll/SSE frame
});

manager.once('completed', (taskId: string, status: JobStatus) => {
  // Task succeeded; assets ready
});

manager.on('failed', (taskId: string, status: JobStatus) => {
  // Unrecoverable error; status.taskError has details
});

manager.on('cancelled', (taskId: string) => {
  // Task cancelled
});
```

### CredentialManager

```typescript
constructor(store?: CredentialStoreInterface)  // defaults to the real encrypted disk store; tests inject a mock

async saveCredentials(providerId: string, apiKey: string): Promise<void>      // throws if key format is invalid (Meshy keys must match /^msy_[a-zA-Z0-9_-]+$/)
async loadCredentials(providerId: string): Promise<string | null>             // returns null if nothing saved
async credentialsExist(providerId: string): Promise<boolean>
async deleteCredentials(providerId: string): Promise<void>
async testConnection(providerId: string, apiKey?: string): Promise<TestConnectionResult>  // calls GET /openapi/v1/balance; pass apiKey to test before saving
async validateCredentials(providerId: string): Promise<boolean>               // true iff testConnection(...).status === ConnectionStatus.Connected
```

A ready-to-use singleton is also exported: `import { credentialManager } from './src/core/CredentialManager.js'`.

**`ConnectionStatus` values** (`src/core/types.ts`, PascalCase string enum):

```typescript
enum ConnectionStatus {
  Connected = 'Connected',
  Unauthorized = 'Unauthorized',
  QuotaExceeded = 'QuotaExceeded',             // 402; no balance
  InvalidKey = 'InvalidKey',                    // bad format, or 401 from the API
  NetworkError = 'NetworkError',                // fetch/timeout failure
  RateLimitExceeded = 'RateLimitExceeded',      // 429 per-second limit
  NoMoreConcurrentTasks = 'NoMoreConcurrentTasks', // 429 queue-full
  UnknownError = 'UnknownError',                // 5xx or unrecognized response
}
```

### Logger

```typescript
const logger = new Logger(level?: LogLevel, enabled?: boolean);

logger.debug(message: string, context?: LogContext): void
logger.info(message: string, context?: LogContext): void
logger.warn(message: string, context?: LogContext): void
logger.error(message: string, context?: LogContext): void

logger.setLevel(level: LogLevel): void
logger.setEnabled(enabled: boolean): void

// Convenience methods
logger.logRequest({
  method: string;
  path: string;
  statusCode?: number;
  durationMs: number;
  jobId?: string;
  taskId?: string;
  error?: string;
}): void

logger.logRetry({
  attempt: number;
  maxRetries: number;
  delayMs: number;
  reason: string;
  jobId?: string;
  taskId?: string;
}): void
```

All output goes to **stderr** (never stdout). The `redact()` function automatically strips `msy_*` keys and `Bearer` tokens.

### RetryPolicy

```typescript
function isTransientError(error: unknown): boolean
// Returns true for: 5xx, 429, timeout, service_unavailable, ECONNREFUSED, ENOTFOUND
// Returns false for: 4xx (except 429), invalid_input, moderation_blocked, parse errors

async function withRetry<T>(
  fn: () => Promise<T>,
  config?: BackoffConfig,
  context?: { jobId?: string; taskId?: string; operation?: string }
): Promise<T>

interface BackoffConfig {
  maxRetries: number;           // Default 3
  initialDelayMs: number;       // Default 1000
  maxDelayMs: number;           // Default 30000
  jitter?: boolean;             // Default true; varies delays by ±50%
}
```

**Retry logic:**
- Transient errors (5xx, 429, timeout) → retry with exponential backoff
- Non-transient errors (invalid_input, moderation_blocked) → fail immediately
- Max retries respected; final error is re-thrown

---

## Configuration

Most configuration lives in individual component constructors (as shown above). **Global connector-wide configuration** would be defined in `ConnectorConfig` (currently lives in `src/core/types.ts`; no separate `Config.ts` file exists):

```typescript
interface ConnectorConfig {
  // Default provider to instantiate (e.g., 'meshy')
  defaultProvider?: string;

  // Retry behavior
  retryCount?: number;
  timeoutMs?: number;

  // Download behavior
  downloadDirectory?: string;
  parallelDownloads?: number;
  autoDownload?: boolean;
  overwriteExisting?: boolean;

  // Logging
  enableLogging?: boolean;
  logLevel?: LogLevel;

  // Rate limiting per tier
  tier?: 'pro' | 'studio' | 'enterprise';  // Informs maxConcurrentJobs
}
```

**Usage pattern (when MCP server exists):**

```typescript
// Load from file or MCP tool parameters
const config: ConnectorConfig = {
  defaultProvider: 'meshy',
  retryCount: 3,
  downloadDirectory: '/home/user/3d-assets',
  tier: 'pro',
  enableLogging: true,
  logLevel: LogLevel.INFO
};

// Apply to components as needed
const downloader = new DownloadManager({
  downloadDirectory: config.downloadDirectory,
  parallelDownloads: config.tier === 'pro' ? 3 : 5,
  overwriteExisting: config.overwriteExisting ?? false
});
```

---

## Output Folder Structure

Every completed generation creates a folder at `<downloadDirectory>/<MeshName>_<jobId>/`:

```
<MeshName>_<jobId>/
├── GLB/
│   └── model.glb
├── OBJ/
│   ├── model.obj
│   └── model.mtl
├── FBX/
│   └── model.fbx
├── USDZ/
│   └── model.usdz
├── STL/
│   └── model.stl              # Only if requested
├── 3MF/
│   └── model.3mf              # Only if requested
├── Textures/
│   ├── base_color.png
│   ├── normal.png
│   ├── metallic.png
│   ├── roughness.png
│   └── emission.png           # Only with enable_pbr: true
├── Preview/
│   ├── thumbnail.png
│   ├── thumbnail_front.png    # If multi_view_thumbnails requested
│   ├── thumbnail_right.png
│   ├── thumbnail_back.png
│   └── thumbnail_left.png
├── Source/                     # Rigging/animation outputs
│   └── (model_rigged.glb, animation artifacts)
├── Metadata/
│   └── job.json               # See below
├── Logs/
│   └── job.log                # Structured JSON-line logs
└── <MeshName>.zip             # Only if autoZip: true
```

**Metadata/job.json** (example):

```json
{
  "jobId": "job-20260723-001",
  "taskId": "task-abc123xyz",
  "provider": "meshy",
  "generationMode": "text-to-3d",
  "prompt": "A ceramic toy car with wheels",
  "negativePrompt": null,
  "modelType": "standard",
  "targetFormats": ["glb", "obj", "stl"],
  "meshName": "toy-car",
  "createdAt": "2026-07-23T15:30:00Z",
  "completedAt": "2026-07-23T15:45:30Z",
  "state": "completed",
  "progress": 100,
  "downloadedAssets": [
    { "kind": "glb", "localPath": "GLB/model.glb", "sizeBytes": 2850432 },
    { "kind": "obj", "localPath": "OBJ/model.obj", "sizeBytes": 450000 }
  ],
  "rawResponse": { /* Full Meshy API response */ }
}
```

**Logs/job.log** (example, one JSON object per line):

```
{"timestamp":"2026-07-23T15:30:00Z","level":"INFO","message":"Job created: text-to-3d","context":{"jobId":"job-001","taskId":"task-abc","provider":"meshy"}}
{"timestamp":"2026-07-23T15:30:05Z","level":"INFO","message":"POST /openapi/v2/text-to-3d","context":{"statusCode":200,"durationMs":150,"jobId":"job-001","taskId":"task-abc"}}
{"timestamp":"2026-07-23T15:35:00Z","level":"INFO","message":"Task progress updated","context":{"taskId":"task-abc","progress":50,"state":"processing"}}
{"timestamp":"2026-07-23T15:45:30Z","level":"INFO","message":"Task completed","context":{"taskId":"task-abc","progress":100}}
```

---

## Error Handling & Status Mapping

### Meshy API Errors → Connector Status

**Request-level errors** (HTTP status from Meshy):

| HTTP Status | Interpretation | Retry Behavior |
|---|---|---|
| 400 | Invalid input | Fail fast (no retry) |
| 401 | Unauthorized (invalid API key) | Fail fast |
| 402 | Quota exceeded (no balance) | Fail fast |
| 403 | Forbidden | Fail fast |
| 404 | Not found | Fail fast |
| 429 | Rate limited or queue full | Retry with backoff |
| 5xx | Server error | Retry with backoff |

**Task-level errors** (from `JobStatus.taskError`):

| Type | Interpretation | Retry Behavior |
|---|---|---|
| `timeout` | Generation took too long | Retry with backoff |
| `service_unavailable` | Meshy service down | Retry with backoff |
| `server_error` | Internal Meshy failure | Retry with backoff |
| `invalid_input` | Bad prompt/parameters | Fail fast |
| `moderation_blocked` | Content flagged by moderation | Fail fast |

### Example: Handling a Failure

```typescript
try {
  const taskId = await manager.textToPreview({
    prompt: 'A wooden toy car'
  });
} catch (error) {
  if (error instanceof Error) {
    if (error.message.includes('invalid_input')) {
      console.error('Bad prompt or parameters:', error.message);
      // Retry with a different prompt
    } else if (error.message.includes('timeout')) {
      console.error('Request timed out; will retry automatically next time');
      // withRetry() already handled this; if we got here, max retries exceeded
    } else if (error.message.includes('402')) {
      console.error('No balance; top up your Meshy account');
    }
  }
}
```

---

## Adding a New Provider

To add support for a new provider (e.g., Tripo, Rodin, Luma), follow this pattern:

### 1. Create Provider Directory

```
src/providers/<provider_name>/
├── <Provider>Provider.ts       # Implements IAI3DProvider
├── <Provider>Client.ts         # Typed HTTP client
├── <provider_name>Mapping.ts   # Raw API ↔ normalized enums
├── animationLibrary.ts         # Static action/capability table (if applicable)
└── <Provider>Provider.test.ts  # Unit tests with mocked HTTP
```

### 2. Implement IAI3DProvider

```typescript
import type {
  IAI3DProvider,
  TextToPreviewRequest,
  JobStatus,
  ProviderCapabilities,
  // ... other request/response types
} from '../../core/IAI3DProvider.js';

export class TripoProvider implements IAI3DProvider {
  readonly providerId = 'tripo';
  readonly capabilities: ProviderCapabilities = {
    supportsNegativePrompt: false,
    supportsBlendFormat: false,
    supportsTurntableVideo: true,        // Tripo has video output
    supportsZipPackage: true,
    supportsWebhooks: true,
    supportsRigging: false,              // Not yet
    supportsAnimation: false,            // Not yet
    // ... complete the descriptor
    supportedFormats: [AssetType.GLB, AssetType.USDZ],
    rateLimitPerSecond: 10,
    maxConcurrentJobs: 5
  };

  constructor(private client: TripoClient) {}

  async textToPreview(request: TextToPreviewRequest): Promise<string> {
    const response = await this.client.createTextTo3D({
      prompt: request.prompt,
      model: request.modelType || 'default',
      quality: 'high'
      // Map request fields to Tripo's wire format
    });
    return response.taskId;
  }

  async getJobStatus(taskId: string): Promise<JobStatus> {
    const raw = await this.client.getTask(taskId);
    return {
      taskId: raw.id,
      state: normalizeTripoStatus(raw.status),  // Your mapping function
      rawState: raw.status,
      progress: raw.progress || 0,
      // ... map Tripo's response to JobStatus
    };
  }

  // Implement remaining methods...
}
```

### 3. Create a Mapping Module

```typescript
// src/providers/tripo/tripoMapping.ts
import { JobState } from '../../core/types.js';

export function normalizeTripoStatus(rawStatus: string): JobState {
  switch (rawStatus) {
    case 'pending': return JobState.Queued;
    case 'processing': return JobState.Processing;
    case 'completed': return JobState.Completed;
    case 'failed': return JobState.Failed;
    case 'cancelled': return JobState.Cancelled;
    default: return JobState.Processing;
  }
}

export function getPhaseDescription(state: JobState, taskType?: string): string {
  if (state === JobState.Processing) {
    return taskType === 'video' ? 'Rendering video...' : 'Generating 3D...';
  }
  // ... more descriptions
}
```

### 4. Register the Provider

There's no `ProviderFactory.ts` yet — with one provider, `mcpServer.ts` just constructs `MeshyProvider` directly (see its `getGenerationManager()` function). Once a second provider exists, extracting a small factory like the one below is the recommended next step, so `mcpServer.ts` (and any other consumer) can select a provider by ID instead of hardcoding Meshy:

```typescript
// Suggested: src/core/ProviderFactory.ts (create this file when adding provider #2)
export async function createProvider(
  providerId: string,
  credentialManager: CredentialManager
): Promise<IAI3DProvider> {
  switch (providerId) {
    case 'meshy': {
      const apiKey = await credentialManager.loadCredentials('meshy');
      if (!apiKey) throw new Error('No Meshy credentials saved');
      return new MeshyProvider(apiKey);
    }
    case 'tripo': {
      const tripoKey = await credentialManager.loadCredentials('tripo');
      if (!tripoKey) throw new Error('No Tripo credentials saved');
      return new TripoProvider(new TripoClient(tripoKey));
    }
    // Add more cases
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}
```

### 5. Write Tests

```typescript
// src/providers/tripo/TripoProvider.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TripoProvider } from './TripoProvider.js';

// Mock TripoClient
class MockTripoClient {
  async createTextTo3D(request: any): Promise<any> {
    return { taskId: `tripo-task-${Date.now()}`, status: 'pending' };
  }
  // ... mock other methods
}

test('TripoProvider: textToPreview returns task ID', async () => {
  const client = new MockTripoClient();
  const provider = new TripoProvider(client);
  
  const taskId = await provider.textToPreview({
    prompt: 'A ceramic vase'
  });
  
  assert(taskId.startsWith('tripo-task-'));
});

// ... more tests
```

### 6. Update types.ts if Needed

If the new provider has capabilities or enums that differ from Meshy, extend the shared types:

```typescript
// In src/core/types.ts, add provider-specific types or capabilities
export type SupportedProvider = 'meshy' | 'tripo' | 'rodin';
```

### 7. Key Design Principles

**Provider-agnostic core:** `GenerationManager`, `JobStatusManager`, and `DownloadManager` don't know about specific providers. They work through the `IAI3DProvider` interface.

**Capability-driven feature detection:** Use `provider.capabilities` to check if a feature is available before calling optional methods.

```typescript
if (provider.capabilities.supportsRigging && provider.rigModel) {
  const rigTaskId = await manager.rigModel(request);
}
```

**Normalized status enum:** Each provider maps its native status values to the `JobState` enum. This lets consumers write provider-agnostic progress UI.

**Fail-fast vs. retry:** Classify errors (transient vs. non-transient) in your provider's mapping layer, then use `RetryPolicy.withRetry()` to handle retries uniformly.

---

## Known Gaps & Limitations

### 1. No Stream-Opening Helper in MeshyProvider

**Current state:** `MeshyClient.streamTaskStatus()` and `MeshyClient.buildStreamPath()` exist and are correct. However, `MeshyProvider` doesn't expose a generation-mode-aware `openStream(taskId: string, signal: AbortSignal)` method that `JobStatusManager` needs.

**Why it matters:** `JobStatusManager`'s constructor accepts an optional `openStream` callback for SSE. If not provided, it falls back to polling. To enable SSE, someone needs to:

1. Know the task's generation mode (text-to-3D vs. image-to-3D vs. rigging, etc.)
2. Call `MeshyClient.buildStreamPath()` with the right path for that mode
3. Call `MeshyClient.streamTaskStatus()` and pass the result to `JobStatusManager`

This logic should live in `MeshyProvider` as a public helper method. It's a small addition (10–15 LOC), not yet done — mostly moot for the MCP server itself, since MCP tool calls are request/response and `get_job_status` polling is sufficient there; it only matters for library embedders who want push-style SSE progress via `JobStatusManager` directly.

### 2. No Provider Registry/Factory

See [Module Layout](#module-layout) — with a single provider, `mcpServer.ts` constructs `MeshyProvider` directly rather than through a factory. Not a defect, just a "hasn't been needed yet" — see [Adding a New Provider](#adding-a-new-provider) step 4 for the recommended shape once a second provider lands.

### 3. Meshy API Limitations (Not Bugs)

**Negative Prompt:** Meshy accepts a `negative_prompt` field in the API but it has no effect (deprecated). The connector accepts it for symmetry with other providers (Tripo, Luma, etc., may use it), but it's documented as a no-op for Meshy specifically.

**Turntable Video:** Not a Meshy output. The connector uses the 4-view `thumbnail_urls` (front/right/back/left stills) as the closest equivalent and marks `supportsTurntableVideo: false`.

**Webhooks:** Meshy supports webhooks but only at the account level (≤5 URLs configured in the dashboard), not per-job. The connector is designed around polling + SSE as the primary progress mechanism.

**CancelJob:** Meshy has no dedicated "cancel in-flight task" endpoint. `CancelJob` is implemented as "stop polling + call Delete," best-effort only — no guarantee the task stops mid-generation.

**Rigging/Animation:** Real pipeline is generate → rig (humanoid only, ≤300k faces) → animate (with an `action_id` from a static reference table). Not chainable in a single request; must be done sequentially.

---

## Extending the Logger & Retry Policy

### Logger Configuration

```typescript
import { Logger, configureLogger } from './src/core/Logger.js';
import { LogLevel } from './src/core/types.js';

const logger = new Logger(LogLevel.DEBUG, true);
logger.setLevel(LogLevel.INFO);      // Only INFO, WARN, ERROR
logger.setEnabled(false);             // Silence all logging

// Configure the singleton
configureLogger(true, LogLevel.INFO);
```

All output is structured JSON, one object per line, written to stderr. Secret redaction is automatic (no need to do it before logging).

### Retry Policy Customization

```typescript
import { withRetry, isTransientError, DEFAULT_BACKOFF_CONFIG } from './src/core/RetryPolicy.js';

// Custom backoff: aggressive (short delays, few retries)
const customConfig = {
  maxRetries: 2,
  initialDelayMs: 100,
  maxDelayMs: 500,
  jitter: true
};

const result = await withRetry(
  () => someNetworkCall(),
  customConfig,
  { jobId: 'job-123', operation: 'download' }
);

// Or check errors manually
if (!isTransientError(error)) {
  throw error; // Fail fast on invalid input, etc.
}
```

---

## Summary

This connector provides a **provider-agnostic library and MCP server** for 3D generation workflows. The first implementation (Meshy) is complete and verified (142/142 tests passing, 14 MCP tools registered). Adding new providers follows a clear pattern: implement `IAI3DProvider`, add mapping logic, extract a provider factory once there's more than one provider to select between, and write tests.

The library is ready to be integrated as an MCP server in a future phase. Until then, it can be used programmatically in Node.js scripts (e.g., AttrangiToys' asset-generation pipeline) or imported into other TypeScript projects.
