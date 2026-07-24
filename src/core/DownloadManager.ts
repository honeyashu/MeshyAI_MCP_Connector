/**
 * Download Manager.
 * Downloads every available asset for a completed generation job, lays them out on
 * disk per PLAN.md §4, writes Metadata/job.json + Logs/job.log, and optionally builds
 * a local ZIP bundle (Meshy doesn't provide one — see PLAN.md §2 item 4) and applies
 * Draco compression to the GLB to meet a caller-configured size budget (PLAN.md §2
 * item 10 — AttrangiToys wants GLB ≤3MB; Meshy's API has no compression option, so
 * this is a local post-process step, not a Meshy capability).
 *
 * Design note: this consumes `JobStatus` (modelUrls/textureUrls/thumbnailUrl(s)) directly
 * rather than routing through `IAI3DProvider.downloadAssets()`. Two reasons: (1) JobStatus
 * already carries thumbnails, which the current per-provider `downloadAssets()` stub does
 * not, and (2) writing files to disk in a specific cross-provider folder layout is a
 * DownloadManager concern, not something each provider implementation should duplicate.
 */

import { createWriteStream } from "fs";
import { mkdir, writeFile, stat, rename, unlink } from "fs/promises";
import { join, dirname } from "path";
import type { JobStatus } from "./IAI3DProvider.js";
import type { JobMetadata } from "./types.js";
import { logger } from "./Logger.js";
import {
  withRetry,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from "./RetryPolicy.js";

export interface DownloadManagerConfig {
  /** Root directory under which `<MeshName>_<jobId>/` folders are created. */
  downloadDirectory: string;
  /** Max simultaneous file downloads per job. */
  parallelDownloads: number;
  /** If false, an existing file at the destination path is left untouched (skipped). */
  overwriteExisting: boolean;
  /** Build a `<MeshName>.zip` of the job folder after downloading. */
  autoZip: boolean;
  /** Attempt Draco compression on the downloaded GLB (best-effort; see resolveGlbBudget()). */
  compressGlb: boolean;
  /** Optional size budget in bytes for the GLB (e.g. 3 * 1024 * 1024 for AttrangiToys). Logged as a warning if unmet, never throws. */
  maxGlbSizeBytes?: number;
  retryConfig?: Partial<BackoffConfig>;
}

export const DEFAULT_DOWNLOAD_CONFIG: Omit<
  DownloadManagerConfig,
  "downloadDirectory"
> = {
  parallelDownloads: 3,
  overwriteExisting: false,
  autoZip: false,
  compressGlb: false,
};

export interface DownloadedFile {
  /** e.g. 'glb', 'fbx', 'base_color', 'thumbnail', 'thumbnail_front' */
  kind: string;
  localPath: string;
  sizeBytes: number;
  url: string;
}

export interface DownloadJobResult {
  jobFolder: string;
  files: DownloadedFile[];
  zipPath?: string;
  warnings: string[];
}

/** Maps a model_urls key to its subfolder + filename per PLAN.md §4. */
const MODEL_ASSET_LAYOUT: Record<string, { folder: string; filename: string }> =
  {
    glb: { folder: "GLB", filename: "model.glb" },
    fbx: { folder: "FBX", filename: "model.fbx" },
    obj: { folder: "OBJ", filename: "model.obj" },
    mtl: { folder: "OBJ", filename: "model.mtl" },
    usdz: { folder: "USDZ", filename: "model.usdz" },
    stl: { folder: "STL", filename: "model.stl" },
    "3mf": { folder: "3MF", filename: "model.3mf" },
    pre_remeshed_glb: { folder: "Source", filename: "pre_remeshed_model.glb" },
  };

/**
 * Extracts a readable message from a caught download error, which may be a real
 * `Error`, or the plain `{ httpStatus, message }` object thrown by `downloadFile()`
 * for non-2xx HTTP responses (see the comment there for why it's not an `Error`).
 */
function describeDownloadError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Runs a batch of async download tasks with bounded concurrency.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const current = nextIndex++;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

export class DownloadManager {
  constructor(private config: DownloadManagerConfig) {}

  /**
   * Downloads every available asset for a job and lays it out per PLAN.md §4.
   */
  async downloadJob(
    job: JobMetadata,
    status: JobStatus,
  ): Promise<DownloadJobResult> {
    const jobFolder = join(
      this.config.downloadDirectory,
      `${job.meshName}_${job.jobId}`,
    );
    const warnings: string[] = [];

    await this.ensureDirs(jobFolder);

    const downloadTasks: Array<() => Promise<DownloadedFile | null>> = [];

    // Model files (GLB, FBX, OBJ+MTL, USDZ, STL, 3MF, pre_remeshed_glb)
    if (status.modelUrls) {
      for (const [key, url] of Object.entries(status.modelUrls)) {
        if (!url) continue;
        downloadTasks.push(() =>
          this.downloadModelAsset(jobFolder, key, url, warnings),
        );
      }
    }

    // Texture maps
    if (status.textureUrls) {
      for (const [key, url] of Object.entries(status.textureUrls)) {
        if (!url) continue;
        downloadTasks.push(() =>
          this.downloadFile(
            url,
            join(jobFolder, "Textures", `${key}.png`),
            key,
            warnings,
          ),
        );
      }
    }

    // Thumbnails
    if (status.thumbnailUrl) {
      downloadTasks.push(() =>
        this.downloadFile(
          status.thumbnailUrl!,
          join(jobFolder, "Preview", "thumbnail.png"),
          "thumbnail",
          warnings,
        ),
      );
    }
    if (status.thumbnailUrls) {
      for (const [view, url] of Object.entries(status.thumbnailUrls)) {
        if (!url) continue;
        downloadTasks.push(() =>
          this.downloadFile(
            url,
            join(jobFolder, "Preview", `thumbnail_${view}.png`),
            `thumbnail_${view}`,
            warnings,
          ),
        );
      }
    }

    const downloaded = (
      await runWithConcurrency(downloadTasks, this.config.parallelDownloads)
    ).filter((f): f is DownloadedFile => f !== null);

    // Draco compression / size-budget handling on the downloaded GLB, if present.
    const glbFile = downloaded.find((f) => f.kind === "glb");
    if (glbFile) {
      await this.applyGlbSizeBudget(glbFile, warnings);
    }

    // Metadata + logs
    await this.writeMetadata(jobFolder, job, status, downloaded);
    await this.writeLog(jobFolder, job, downloaded, warnings);

    // Optional zip
    let zipPath: string | undefined;
    if (this.config.autoZip) {
      zipPath = await this.zipJobFolder(jobFolder, job.meshName, warnings);
    }

    return { jobFolder, files: downloaded, zipPath, warnings };
  }

  private async ensureDirs(jobFolder: string): Promise<void> {
    const subfolders = [
      "GLB",
      "OBJ",
      "FBX",
      "USDZ",
      "STL",
      "3MF",
      "Textures",
      "Preview",
      "Source",
      "Metadata",
      "Logs",
    ];
    await mkdir(jobFolder, { recursive: true });
    await Promise.all(
      subfolders.map((f) => mkdir(join(jobFolder, f), { recursive: true })),
    );
  }

  private async downloadModelAsset(
    jobFolder: string,
    key: string,
    url: string,
    warnings: string[],
  ): Promise<DownloadedFile | null> {
    const layout = MODEL_ASSET_LAYOUT[key];
    if (!layout) {
      warnings.push(
        `Unknown model asset key "${key}" — skipped (not in PLAN.md §4 layout)`,
      );
      return null;
    }
    return this.downloadFile(
      url,
      join(jobFolder, layout.folder, layout.filename),
      key,
      warnings,
    );
  }

  /**
   * Downloads a single file with retry, respecting overwriteExisting.
   * Returns null (with a warning logged) on unrecoverable failure rather than
   * failing the whole job — partial downloads are more useful than none.
   */
  private async downloadFile(
    url: string,
    destPath: string,
    kind: string,
    warnings: string[],
  ): Promise<DownloadedFile | null> {
    if (!this.config.overwriteExisting) {
      try {
        const existing = await stat(destPath);
        if (existing.isFile()) {
          logger.debug(
            `Skipping existing file (overwriteExisting=false): ${destPath}`,
          );
          return { kind, localPath: destPath, sizeBytes: existing.size, url };
        }
      } catch {
        // Doesn't exist yet — proceed to download.
      }
    }

    try {
      const buffer = await withRetry(
        async () => {
          const response = await fetch(url);
          if (!response.ok) {
            // Thrown as a ProviderError-shaped object (not a plain Error) so
            // RetryPolicy.isTransientError() can classify it by httpStatus — a
            // plain Error here would fall through to message-string matching,
            // which doesn't recognize "500"/"503" and would wrongly fail fast
            // on a transient asset-host outage.
            throw {
              httpStatus: response.status,
              message: `Download failed (${response.status}): ${url}`,
            };
          }
          return Buffer.from(await response.arrayBuffer());
        },
        { ...DEFAULT_BACKOFF_CONFIG, ...this.config.retryConfig },
      );

      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, buffer);

      logger.info(`Downloaded ${kind}`, { destPath, sizeBytes: buffer.length });
      return { kind, localPath: destPath, sizeBytes: buffer.length, url };
    } catch (error) {
      const message = `Failed to download ${kind} from ${url}: ${describeDownloadError(error)}`;
      logger.error(message);
      warnings.push(message);
      return null;
    }
  }

  /**
   * Applies Draco compression to the GLB if configured, and checks the result
   * against maxGlbSizeBytes. Both are best-effort: a missing optional dependency
   * or a still-over-budget result are logged as warnings, never thrown, since
   * an uncompressed/over-budget asset is still a usable deliverable.
   */
  private async applyGlbSizeBudget(
    glbFile: DownloadedFile,
    warnings: string[],
  ): Promise<void> {
    if (this.config.compressGlb) {
      const compressed = await this.tryCompressGlb(glbFile.localPath);
      if (compressed) {
        const newStat = await stat(glbFile.localPath);
        glbFile.sizeBytes = newStat.size;
        logger.info("Draco-compressed GLB", {
          path: glbFile.localPath,
          sizeBytes: newStat.size,
        });
      } else {
        warnings.push(
          "Draco compression requested but @gltf-transform/core (or draco3d) is not installed — GLB left uncompressed. " +
            "Install the optional dependencies to enable this (see package.json optionalDependencies).",
        );
      }
    }

    if (
      this.config.maxGlbSizeBytes &&
      glbFile.sizeBytes > this.config.maxGlbSizeBytes
    ) {
      warnings.push(
        `GLB size ${glbFile.sizeBytes} bytes exceeds configured budget of ${this.config.maxGlbSizeBytes} bytes ` +
          `(${glbFile.localPath}). Consider enabling compressGlb, requesting a lower target_polycount, or a smaller ` +
          `texture resolution (hd_texture: false) on the generation request.`,
      );
    }
  }

  /**
   * Attempts in-place Draco compression via @gltf-transform. Returns false (without
   * throwing) if the optional dependency isn't installed or compression fails —
   * this is a best-effort enhancement, not a hard requirement.
   *
   * Types verified against the real installed packages (Phase 9+ follow-up, once a
   * working `npm install` became possible via /tmp — see MEMORY.md §7). The original
   * version of this method was written without a compiler available and guessed an
   * `encoderModule` option on `draco()` that doesn't exist on the real `DracoOptions`
   * type — draco3d's WASM modules are wired up via `io.registerDependencies()` +
   * `io.registerExtensions([KHRDracoMeshCompression])` instead, per the real API.
   */
  private async tryCompressGlb(glbPath: string): Promise<boolean> {
    try {
      // Dynamic imports: all optionalDependencies (see package.json). `@gltf-transform/
      // extensions` is a transitive dep of `@gltf-transform/functions`, always present
      // alongside it, but imported directly here for KHRDracoMeshCompression.
      const [{ NodeIO }, { draco }, { KHRDracoMeshCompression }, draco3d] =
        await Promise.all([
          import("@gltf-transform/core"),
          import("@gltf-transform/functions"),
          import("@gltf-transform/extensions"),
          import("draco3d"),
        ]);

      const io = new NodeIO()
        .registerExtensions([KHRDracoMeshCompression])
        .registerDependencies({
          "draco3d.decoder": await draco3d.createDecoderModule(),
          "draco3d.encoder": await draco3d.createEncoderModule(),
        });

      const document = await io.read(glbPath);
      await document.transform(draco({ method: "edgebreaker" }));

      const tmpPath = `${glbPath}.compressed.tmp`;
      await io.write(tmpPath, document);
      await unlink(glbPath);
      await rename(tmpPath, glbPath);
      return true;
    } catch (error) {
      logger.warn("Draco compression unavailable or failed", {
        glbPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Writes Metadata/job.json — prompt, negative prompt, generation settings, provider,
   * mesh stats (if Meshy provides them), creation date, job ID, and the raw API response.
   * Per original spec §10 (Output Structure).
   */
  private async writeMetadata(
    jobFolder: string,
    job: JobMetadata,
    status: JobStatus,
    downloaded: DownloadedFile[],
  ): Promise<void> {
    const metadata = {
      jobId: job.jobId,
      taskId: job.taskId,
      provider: job.provider,
      generationMode: job.generationMode,
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      modelType: job.modelType,
      targetFormats: job.targetFormats,
      meshName: job.meshName,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      state: job.state,
      consumedCredits: job.consumedCredits,
      downloadedFiles: downloaded.map((f) => ({
        kind: f.kind,
        path: f.localPath,
        sizeBytes: f.sizeBytes,
      })),
      apiResponse: status.rawResponse ?? null,
    };

    await writeFile(
      join(jobFolder, "Metadata", "job.json"),
      JSON.stringify(metadata, null, 2),
      "utf8",
    );
  }

  /**
   * Writes Logs/job.log — a plain-text summary of what was downloaded and any warnings.
   * Per original spec §12 (Logging): downloaded files, errors, warnings.
   */
  private async writeLog(
    jobFolder: string,
    job: JobMetadata,
    downloaded: DownloadedFile[],
    warnings: string[],
  ): Promise<void> {
    const lines: string[] = [
      `[${new Date().toISOString()}] Download started for job ${job.jobId} (task ${job.taskId})`,
      ...downloaded.map(
        (f) =>
          `[${new Date().toISOString()}] Downloaded ${f.kind} -> ${f.localPath} (${f.sizeBytes} bytes)`,
      ),
      ...warnings.map((w) => `[${new Date().toISOString()}] WARNING: ${w}`),
      `[${new Date().toISOString()}] Download complete: ${downloaded.length} files, ${warnings.length} warnings`,
    ];

    await writeFile(
      join(jobFolder, "Logs", "job.log"),
      lines.join("\n") + "\n",
      "utf8",
    );
  }

  /**
   * Builds `<MeshName>.zip` inside the job folder from every subfolder except itself.
   * Uses `archiver` (pure JS, no native compile) since Meshy doesn't provide a bundled
   * ZIP (PLAN.md §2 item 4).
   */
  private async zipJobFolder(
    jobFolder: string,
    meshName: string,
    warnings: string[],
  ): Promise<string | undefined> {
    try {
      const archiverModule = await import("archiver");
      const archiver = archiverModule.default;
      const zipPath = join(jobFolder, `${meshName}.zip`);

      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", () => resolve());
        archive.on("error", (err: Error) => reject(err));

        archive.pipe(output);
        archive.glob("**/*", {
          cwd: jobFolder,
          ignore: [`${meshName}.zip`],
        });
        archive.finalize();
      });

      logger.info("Job folder zipped", { zipPath });
      return zipPath;
    } catch (error) {
      const message = `Failed to zip job folder: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.error(message);
      warnings.push(message);
      return undefined;
    }
  }
}
