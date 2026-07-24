/**
 * MCP server entry point.
 *
 * Wires the provider-agnostic library (CredentialManager, GenerationManager,
 * DownloadManager) up to the Model Context Protocol so an MCP client (Claude
 * Desktop, Cowork, Claude Code, etc.) can drive Meshy AI 3D generation
 * through tool calls, per PLAN.md §3's module layout.
 *
 * DESIGN NOTE — no `JobStatusManager` (SSE/event-emitter progress) in this
 * server: MCP tool calls are client-initiated request/response, not a
 * long-lived event channel — a client polls `get_job_status` on whatever
 * cadence it wants, which is the natural fit for MCP's protocol shape.
 * `JobStatusManager`'s SSE support (`JobStatusManager.ts`) exists and is
 * tested for callers embedding the library directly in Node code (e.g. an
 * AttrangiToys build script watching a job to completion) but isn't wired
 * into this server. `get_job_status` covers the "am I done yet" need for
 * MCP clients directly via `GenerationManager.getJobStatus()`.
 *
 * DESIGN NOTE — no SSE stream routing here either, for the same reason
 * this server doesn't use `JobStatusManager`: even a caller reaching for
 * `MeshyClient.streamTaskStatus()`/`buildStreamPath()` directly needs to
 * know which generation mode a given taskId belongs to to build the right
 * stream path, and `MeshyProvider` doesn't track that (only `JobMetadata`
 * does) — a real but separate gap, documented in MEMORY.md §7a.
 *
 * CONFIGURATION — all read from environment variables, all optional, per
 * PLAN.md §5 ("all overridable via a config file or MCP tool call, none
 * hardcoded into logic"):
 *   MESHY_DOWNLOAD_DIR       default download directory (default: ./meshy-downloads)
 *   MESHY_TIMEOUT_MS         HTTP request timeout (default: 30000)
 *   MESHY_MAX_RETRIES        retry attempts for transient errors (default: 3)
 *   MESHY_PARALLEL_DOWNLOADS concurrent file downloads per job (default: 3)
 *   MESHY_OVERWRITE_EXISTING "true"/"false" (default: false)
 *   MESHY_AUTO_ZIP           "true"/"false", zip each job folder (default: false)
 *   MESHY_COMPRESS_GLB       "true"/"false", best-effort Draco compression (default: false)
 *   MESHY_MAX_GLB_SIZE_BYTES optional size budget, logs a warning if exceeded
 *   MESHY_ENABLE_LOGGING     "true"/"false" (default: true)
 *   MESHY_LOG_LEVEL          DEBUG|INFO|WARN|ERROR (default: INFO)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CredentialManager } from "../core/CredentialManager.js";
import {
  GenerationManager,
  initGenerationManager,
} from "../core/GenerationManager.js";
import { DownloadManager } from "../core/DownloadManager.js";
import { MeshyProvider } from "../providers/meshy/MeshyProvider.js";
import { createJobStore } from "../store/jobStore.js";
import { logger, configureLogger } from "../core/Logger.js";
import { LogLevel, AssetType } from "../core/types.js";
import {
  listAnimationActions,
  isValidActionId,
} from "../providers/meshy/animationLibrary.js";

// ---------------------------------------------------------------------------
// Configuration (env-driven, see file header)
// ---------------------------------------------------------------------------

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  downloadDirectory: process.env.MESHY_DOWNLOAD_DIR ?? "./meshy-downloads",
  timeoutMs: envNumber("MESHY_TIMEOUT_MS", 30000),
  maxRetries: envNumber("MESHY_MAX_RETRIES", 3),
  parallelDownloads: envNumber("MESHY_PARALLEL_DOWNLOADS", 3),
  overwriteExisting: envBool("MESHY_OVERWRITE_EXISTING", false),
  autoZip: envBool("MESHY_AUTO_ZIP", false),
  compressGlb: envBool("MESHY_COMPRESS_GLB", false),
  maxGlbSizeBytes: process.env.MESHY_MAX_GLB_SIZE_BYTES
    ? envNumber("MESHY_MAX_GLB_SIZE_BYTES", 0) || undefined
    : undefined,
  enableLogging: envBool("MESHY_ENABLE_LOGGING", true),
  logLevel:
    (process.env.MESHY_LOG_LEVEL as LogLevel | undefined) ?? LogLevel.INFO,
};

configureLogger(config.enableLogging, config.logLevel);

// ---------------------------------------------------------------------------
// Lazy provider/manager bootstrap. The Meshy API key may not exist yet at
// process start (first-run: the user calls save_credentials first), so
// nothing here eagerly requires a valid key.
// ---------------------------------------------------------------------------

const credentialManager = new CredentialManager();

let provider: MeshyProvider | null = null;
let generationManager: GenerationManager | null = null;

async function getGenerationManager(): Promise<GenerationManager> {
  if (generationManager) return generationManager;

  const apiKey = await credentialManager.loadCredentials("meshy");
  if (!apiKey) {
    throw new Error(
      "No Meshy API key configured. Call the save_credentials tool first " +
        "with your Meshy API key (starts with 'msy_').",
    );
  }

  provider = new MeshyProvider(apiKey, config.timeoutMs);
  const jobStore = await createJobStore(); // undefined if better-sqlite3 unavailable — in-memory fallback
  generationManager = initGenerationManager(
    provider,
    { maxRetries: config.maxRetries },
    jobStore,
  );

  return generationManager;
}

function getDownloadManager(overrides?: {
  downloadDirectory?: string;
  overwriteExisting?: boolean;
  autoZip?: boolean;
  compressGlb?: boolean;
}): DownloadManager {
  return new DownloadManager({
    downloadDirectory: overrides?.downloadDirectory ?? config.downloadDirectory,
    parallelDownloads: config.parallelDownloads,
    overwriteExisting: overrides?.overwriteExisting ?? config.overwriteExisting,
    autoZip: overrides?.autoZip ?? config.autoZip,
    compressGlb: overrides?.compressGlb ?? config.compressGlb,
    maxGlbSizeBytes: config.maxGlbSizeBytes,
    retryConfig: { maxRetries: config.maxRetries },
  });
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("Tool call failed", { error: message });
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Server + tool registration
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "meshy-ai-connector",
  version: "0.1.0",
});

const assetTypeSchema = z.nativeEnum(AssetType);

// --- Credentials -----------------------------------------------------------

server.registerTool(
  "save_credentials",
  {
    title: "Save Meshy API credentials",
    description:
      "Saves a Meshy AI API key to the local encrypted credential store " +
      "(AES-256-GCM, ~/.meshy-connector/). Must be called once before any " +
      "generation tool will work.",
    inputSchema: {
      apiKey: z
        .string()
        .describe(
          "Meshy API key, starts with 'msy_'. Get one at https://www.meshy.ai/api",
        ),
    },
  },
  async ({ apiKey }) => {
    try {
      await credentialManager.saveCredentials("meshy", apiKey);
      // Force re-bootstrap of provider/manager on next call with the new key.
      provider = null;
      generationManager = null;
      return ok({ saved: true, provider: "meshy" });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "test_connection",
  {
    title: "Test Meshy API connection",
    description:
      "Validates the stored Meshy API key against the real API and returns " +
      "connection status (Connected/InvalidKey/QuotaExceeded/RateLimitExceeded/" +
      "NetworkError/UnknownError) plus current credit balance if connected.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await credentialManager.testConnection("meshy");
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_balance",
  {
    title: "Get Meshy account balance",
    description: "Returns the current Meshy account credit balance.",
    inputSchema: {},
  },
  async () => {
    try {
      await getGenerationManager(); // ensures `provider` below is bootstrapped
      const balance = await provider!.getBalance();
      return ok({ balance });
    } catch (error) {
      return fail(error);
    }
  },
);

// --- Generation --------------------------------------------------------------

server.registerTool(
  "generate_text_to_3d_preview",
  {
    title: "Text-to-3D: preview (untextured mesh)",
    description:
      "Generates an untextured 3D mesh from a text prompt (Meshy's 'preview' " +
      "phase). Returns a taskId. To add texturing, poll get_job_status until " +
      "state is 'Completed', then call refine_text_to_3d with this taskId as " +
      "previewTaskId. Preview→refine is NOT automatic (predictable, no hidden work).",
    inputSchema: {
      prompt: z
        .string()
        .max(600)
        .describe("Text description of the 3D model (max 600 chars)"),
      negativePrompt: z
        .string()
        .optional()
        .describe(
          "Accepted but currently a no-op on Meshy's API (surfaced as-is)",
        ),
      modelType: z.string().optional(),
      aiModel: z
        .string()
        .optional()
        .describe(
          "e.g. 'meshy-4', 'meshy-5' — check Meshy docs for current models",
        ),
      shouldRemesh: z.boolean().optional(),
      topology: z.string().optional().describe("e.g. 'quad' or 'triangle'"),
      targetPolycount: z.number().int().positive().optional(),
      decimationMode: z.string().optional(),
      poseMode: z.string().optional(),
      targetFormats: z.array(assetTypeSchema).optional(),
      autoSize: z.boolean().optional(),
      originAt: z.string().optional(),
      moderation: z.boolean().optional(),
      alphaThumbnail: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const manager = await getGenerationManager();
      const taskId = await manager.textToPreview(args);
      return ok({
        taskId,
        nextStep:
          "Poll get_job_status, then call refine_text_to_3d once Completed.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "refine_text_to_3d",
  {
    title: "Text-to-3D: refine (add texturing)",
    description:
      "Refines a completed text-to-3D preview task with texturing and/or " +
      "format changes. Requires a previewTaskId from a Completed preview task.",
    inputSchema: {
      previewTaskId: z.string(),
      enablePbr: z.boolean().optional(),
      hdTexture: z.boolean().optional(),
      texturePrompt: z.string().optional(),
      textureImageUrl: z.string().url().optional(),
      removeLighting: z.boolean().optional(),
      targetFormats: z.array(assetTypeSchema).optional(),
      autoSize: z.boolean().optional(),
      originAt: z.string().optional(),
    },
  },
  async ({ previewTaskId, ...rest }) => {
    try {
      const manager = await getGenerationManager();
      const taskId = await manager.textToRefine(previewTaskId, {
        previewTaskId,
        ...rest,
      });
      return ok({ taskId });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "generate_image_to_3d",
  {
    title: "Image-to-3D",
    description:
      "Generates a textured 3D model from a single reference image. Preferred " +
      "over text-to-3D for characters/products (better fidelity to a real " +
      "reference). Texturing happens inline — no separate refine call needed.",
    inputSchema: {
      imageUrl: z
        .string()
        .url()
        .optional()
        .describe("Publicly reachable image URL"),
      inputTaskId: z
        .string()
        .optional()
        .describe("Alternative to imageUrl: chain from a prior task"),
      modelType: z.string().optional(),
      shouldTexture: z.boolean().optional(),
      enablePbr: z.boolean().optional(),
      hdTexture: z.boolean().optional(),
      texturePrompt: z.string().optional(),
      textureImageUrl: z.string().url().optional(),
      targetPolycount: z.number().int().positive().optional(),
      targetFormats: z.array(assetTypeSchema).optional(),
      multiViewThumbnails: z.boolean().optional(),
      autoSize: z.boolean().optional(),
      originAt: z.string().optional(),
      shouldRemesh: z.boolean().optional(),
      topology: z.string().optional(),
      decimationMode: z.string().optional(),
      savePreRemeshedModel: z.boolean().optional(),
      poseMode: z.string().optional(),
      imageEnhancement: z.boolean().optional(),
      removeLighting: z.boolean().optional(),
      moderation: z.boolean().optional(),
      alphaThumbnail: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const manager = await getGenerationManager();
      const taskId = await manager.imageToThreeD(args);
      return ok({ taskId });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "generate_multi_image_to_3d",
  {
    title: "Multi-Image-to-3D",
    description:
      "Generates a textured 3D model from 1-4 reference images of the same " +
      "subject from different angles, for better geometry reconstruction than " +
      "a single image.",
    inputSchema: {
      imageUrls: z.array(z.string().url()).min(1).max(4),
      modelType: z.string().optional(),
      shouldTexture: z.boolean().optional(),
      enablePbr: z.boolean().optional(),
      hdTexture: z.boolean().optional(),
      texturePrompt: z.string().optional(),
      textureImageUrl: z.string().url().optional(),
      targetPolycount: z.number().int().positive().optional(),
      targetFormats: z.array(assetTypeSchema).optional(),
      multiViewThumbnails: z.boolean().optional(),
      autoSize: z.boolean().optional(),
      originAt: z.string().optional(),
      shouldRemesh: z.boolean().optional(),
      topology: z.string().optional(),
      decimationMode: z.string().optional(),
      savePreRemeshedModel: z.boolean().optional(),
      poseMode: z.string().optional(),
      imageEnhancement: z.boolean().optional(),
      removeLighting: z.boolean().optional(),
      moderation: z.boolean().optional(),
      alphaThumbnail: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const manager = await getGenerationManager();
      const taskId = await manager.multiImageToThreeD(args);
      return ok({ taskId });
    } catch (error) {
      return fail(error);
    }
  },
);

// --- Rigging / animation -----------------------------------------------------

server.registerTool(
  "rig_model",
  {
    title: "Rig a humanoid model",
    description:
      "Rigs a completed humanoid model (≤300k faces) for animation. Provide " +
      "either inputTaskId (a completed generation task) or modelUrl. Does NOT " +
      "automatically chain into animate_model.",
    inputSchema: {
      inputTaskId: z.string().optional(),
      modelUrl: z.string().url().optional(),
      heightMeters: z.number().positive().optional(),
    },
  },
  async (args) => {
    try {
      const manager = await getGenerationManager();
      const taskId = await manager.rigModel(args);
      return ok({ taskId });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_animation_actions",
  {
    title: "List available animation actions",
    description:
      "Lists the static catalog of action IDs usable with animate_model " +
      "(Meshy doesn't expose this as a queryable API — see animationLibrary.ts). " +
      "Call this before animate_model to pick a valid actionId.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok({ actions: listAnimationActions() });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "animate_model",
  {
    title: "Animate a rigged model",
    description:
      "Animates a completed rigging task with a specific action. Requires a " +
      "rigTaskId from a Completed rig_model task and a valid actionId (see " +
      "list_animation_actions). An unknown actionId falls back to 'idle' with a warning.",
    inputSchema: {
      rigTaskId: z.string(),
      actionId: z.string(),
      changeFps: z.number().int().positive().optional(),
      fbx2usdz: z.boolean().optional(),
      extractArmature: z.boolean().optional(),
    },
  },
  async ({ rigTaskId, actionId, changeFps, fbx2usdz, extractArmature }) => {
    try {
      if (!isValidActionId(actionId)) {
        logger.warn(
          `Unknown actionId '${actionId}' requested via MCP tool call`,
        );
      }
      const manager = await getGenerationManager();
      const taskId = await manager.animateModel(rigTaskId, {
        actionId,
        postProcess:
          changeFps !== undefined ||
          fbx2usdz !== undefined ||
          extractArmature !== undefined
            ? { changeFps, fbx2usdz, extractArmature }
            : undefined,
      });
      return ok({ taskId });
    } catch (error) {
      return fail(error);
    }
  },
);

// --- Job management ----------------------------------------------------------

server.registerTool(
  "get_job_status",
  {
    title: "Get generation job status",
    description:
      "Polls the current status of a generation task: normalized state " +
      "(Queued/Processing/Meshing/Texturing/Completed/Failed/Cancelled), " +
      "progress (0-100), asset URLs once available, and error details if failed.",
    inputSchema: { taskId: z.string() },
  },
  async ({ taskId }) => {
    try {
      const manager = await getGenerationManager();
      const status = await manager.getJobStatus(taskId);
      return ok(status);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "cancel_job",
  {
    title: "Cancel a generation job",
    description:
      "Best-effort cancellation of a generation task (Meshy has no true " +
      "graceful-cancel endpoint; this stops local tracking and calls Delete).",
    inputSchema: { taskId: z.string() },
  },
  async ({ taskId }) => {
    try {
      const manager = await getGenerationManager();
      await manager.cancelJob(taskId);
      return ok({ cancelled: true, taskId });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_jobs",
  {
    title: "List tracked generation jobs",
    description:
      "Lists task IDs tracked by this server process (in-memory, or from the " +
      "SQLite job store if better-sqlite3 is available). Does not query Meshy " +
      "directly — Meshy has no list-all-tasks endpoint.",
    inputSchema: {},
  },
  async () => {
    try {
      const manager = await getGenerationManager();
      return ok({ taskIds: manager.listJobs() });
    } catch (error) {
      return fail(error);
    }
  },
);

// --- Downloads -----------------------------------------------------------

server.registerTool(
  "download_job_assets",
  {
    title: "Download all assets for a completed job",
    description:
      "Downloads every available asset (GLB/FBX/OBJ/USDZ/STL/3MF, textures, " +
      "thumbnails) for a completed job into <downloadDirectory>/<MeshName>_<jobId>/, " +
      "following the standard folder layout, and writes Metadata/job.json + " +
      "Logs/job.log. Meshy retains assets for only 3 days — download promptly " +
      "after completion.",
    inputSchema: {
      taskId: z.string(),
      downloadDirectory: z
        .string()
        .optional()
        .describe("Overrides MESHY_DOWNLOAD_DIR for this call"),
      overwriteExisting: z.boolean().optional(),
      autoZip: z
        .boolean()
        .optional()
        .describe("Also build a <MeshName>.zip of the job folder"),
      compressGlb: z
        .boolean()
        .optional()
        .describe(
          "Best-effort local Draco compression (requires optional deps)",
        ),
    },
  },
  async ({
    taskId,
    downloadDirectory,
    overwriteExisting,
    autoZip,
    compressGlb,
  }) => {
    try {
      const manager = await getGenerationManager();
      const status = await manager.getJobStatus(taskId);
      const job = manager.getJobMetadata(taskId);
      if (!job) {
        throw new Error(
          `Task ${taskId} is not tracked by this server process (job metadata not found). ` +
            "Only jobs created via this server's generation tools can be downloaded.",
        );
      }

      const downloader = getDownloadManager({
        downloadDirectory,
        overwriteExisting,
        autoZip,
        compressGlb,
      });
      const result = await downloader.downloadJob(job, status);
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Meshy AI Claude Connector MCP server started", {
    downloadDirectory: config.downloadDirectory,
  });
}

main().catch((error) => {
  logger.error("Fatal error starting MCP server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
