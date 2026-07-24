/**
 * Unit tests for DownloadManager.
 * Tests asset downloads with mock fetch, folder layout validation,
 * overwriteExisting behavior, retry logic, metadata/log writes, and compression hints.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, writeFile, readFile, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { DownloadManager, DEFAULT_DOWNLOAD_CONFIG } from "./DownloadManager.js";
import type { JobStatus } from "./IAI3DProvider.js";
import { JobState, GenerationMode, AssetType } from "./types.js";
import type { JobMetadata } from "./types.js";

// Mock fetch for testing
let mockFetchImpl: ((url: string) => Promise<Response>) | null = null;

const originalFetch = global.fetch as any;

function setMockFetch(impl: (url: string) => Promise<Response>) {
  mockFetchImpl = impl;
  (global as any).fetch = async (url: string) => {
    if (!mockFetchImpl) throw new Error("No mock fetch configured");
    return mockFetchImpl(url);
  };
}

function restoreFetch() {
  (global as any).fetch = originalFetch;
  mockFetchImpl = null;
}

function createMockResponse(
  status: number,
  body: Buffer,
  ok?: boolean,
): Response {
  return {
    ok: ok !== undefined ? ok : status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body,
    json: async () => JSON.parse(body.toString()),
    text: async () => body.toString(),
    clone: () => createMockResponse(status, body),
    headers: new Map(),
    statusText: "OK",
  } as any;
}

test("DownloadManager: downloads a single model asset", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  const glbBuffer = Buffer.from("fake GLB data");
  setMockFetch(async (url: string) => {
    if (url.includes("model.glb")) {
      return createMockResponse(200, glbBuffer);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
    });

    const job: JobMetadata = {
      jobId: "job-123",
      taskId: "task-123",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "A cube",
      targetFormats: [AssetType.GLB],
      meshName: "test-cube",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-123",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
      },
    };

    const result = await manager.downloadJob(job, status);

    assert(result.jobFolder.includes("test-cube_job-123"));
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].kind, "glb");
    assert.equal(result.files[0].sizeBytes, glbBuffer.length);

    // Verify folder layout
    const glbPath = join(result.jobFolder, "GLB", "model.glb");
    const glbContent = await readFile(glbPath);
    assert.deepEqual(glbContent, glbBuffer);
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: creates correct folder structure", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  const fileBuffers: Record<string, Buffer> = {
    "model.glb": Buffer.from("glb"),
    "model.obj": Buffer.from("obj"),
    "model.mtl": Buffer.from("mtl"),
    "base_color.png": Buffer.from("texture"),
  };

  setMockFetch(async (url: string) => {
    for (const [filename, buffer] of Object.entries(fileBuffers)) {
      if (url.includes(filename)) {
        return createMockResponse(200, buffer);
      }
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
    });

    const job: JobMetadata = {
      jobId: "job-456",
      taskId: "task-456",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Multi-format test",
      targetFormats: [AssetType.GLB, AssetType.OBJ, AssetType.FBX],
      meshName: "multi-format",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-456",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
        obj: "https://example.com/model.obj",
        mtl: "https://example.com/model.mtl",
      },
      textureUrls: {
        base_color: "https://example.com/base_color.png",
      },
    };

    const result = await manager.downloadJob(job, status);

    // Verify folder structure per PLAN.md §4
    const glbPath = join(result.jobFolder, "GLB", "model.glb");
    const objPath = join(result.jobFolder, "OBJ", "model.obj");
    const mtlPath = join(result.jobFolder, "OBJ", "model.mtl");
    const texturePath = join(result.jobFolder, "Textures", "base_color.png");

    await stat(glbPath);
    await stat(objPath);
    await stat(mtlPath);
    await stat(texturePath);
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: respects overwriteExisting=false", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  // Pre-create a file
  const jobFolder = join(tempDir, "test-cube_job-789");
  const glbDir = join(jobFolder, "GLB");
  await mkdir(glbDir, { recursive: true });
  const glbPath = join(glbDir, "model.glb");
  const originalContent = Buffer.from("original GLB data");
  await writeFile(glbPath, originalContent);

  const newGlbContent = Buffer.from("new GLB data");
  setMockFetch(async (url: string) => {
    if (url.includes("model.glb")) {
      return createMockResponse(200, newGlbContent);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
      overwriteExisting: false,
    });

    const job: JobMetadata = {
      jobId: "job-789",
      taskId: "task-789",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Overwrite test",
      targetFormats: [AssetType.GLB],
      meshName: "test-cube",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-789",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
      },
    };

    const result = await manager.downloadJob(job, status);

    // File should not be overwritten
    const fileContent = await readFile(glbPath);
    assert.deepEqual(fileContent, originalContent);
    assert.equal(result.files[0].sizeBytes, originalContent.length);
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: overwrites when overwriteExisting=true", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  // Pre-create a file
  const jobFolder = join(tempDir, "test-cube_job-999");
  const glbDir = join(jobFolder, "GLB");
  await mkdir(glbDir, { recursive: true });
  const glbPath = join(glbDir, "model.glb");
  const originalContent = Buffer.from("old");
  await writeFile(glbPath, originalContent);

  const newGlbContent = Buffer.from("new GLB data that is larger");
  setMockFetch(async (url: string) => {
    if (url.includes("model.glb")) {
      return createMockResponse(200, newGlbContent);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
      overwriteExisting: true,
    });

    const job: JobMetadata = {
      jobId: "job-999",
      taskId: "task-999",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Overwrite test",
      targetFormats: [AssetType.GLB],
      meshName: "test-cube",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-999",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
      },
    };

    const result = await manager.downloadJob(job, status);

    // File should be overwritten
    const fileContent = await readFile(glbPath);
    assert.deepEqual(fileContent, newGlbContent);
    assert.equal(result.files[0].sizeBytes, newGlbContent.length);
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: fails and warns on non-2xx HTTP", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  setMockFetch(async (url: string) => {
    if (url.includes("model.glb")) {
      return createMockResponse(500, Buffer.from("error"));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
    });

    const job: JobMetadata = {
      jobId: "job-err",
      taskId: "task-err",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Error test",
      targetFormats: [AssetType.GLB],
      meshName: "test-error",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-err",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
      },
    };

    const result = await manager.downloadJob(job, status);

    // Should have warning and zero files
    assert.equal(result.files.length, 0);
    assert(result.warnings.some((w) => w.includes("Failed to download")));
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: retries transient errors", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  let attemptCount = 0;
  const glbBuffer = Buffer.from("success");

  setMockFetch(async (url: string) => {
    if (!url.includes("model.glb")) {
      throw new Error(`Unexpected URL: ${url}`);
    }
    attemptCount++;
    if (attemptCount < 2) {
      // First attempt fails with 503 (transient)
      return createMockResponse(503, Buffer.from("service unavailable"));
    }
    // Second attempt succeeds
    return createMockResponse(200, glbBuffer);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
      retryConfig: {
        maxRetries: 2,
        initialDelayMs: 1,
        maxDelayMs: 1,
      },
    });

    const job: JobMetadata = {
      jobId: "job-retry",
      taskId: "task-retry",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Retry test",
      targetFormats: [AssetType.GLB],
      meshName: "test-retry",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-retry",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
      },
    };

    const result = await manager.downloadJob(job, status);

    // Should succeed after retry
    assert.equal(result.files.length, 1);
    assert.equal(attemptCount, 2);
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: partial failures do not fail the job", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  const fileBuffers: Record<string, Buffer> = {
    "model.glb": Buffer.from("glb data"),
    "base_color.png": Buffer.from("texture"),
  };

  setMockFetch(async (url: string) => {
    if (url.includes("model.glb")) {
      return createMockResponse(200, fileBuffers["model.glb"]);
    }
    if (url.includes("base_color.png")) {
      // Texture fails
      return createMockResponse(404, Buffer.from("not found"));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
    });

    const job: JobMetadata = {
      jobId: "job-partial",
      taskId: "task-partial",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Partial failure test",
      targetFormats: [AssetType.GLB],
      meshName: "test-partial",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-partial",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
      },
      textureUrls: {
        base_color: "https://example.com/base_color.png",
      },
    };

    const result = await manager.downloadJob(job, status);

    // GLB should be downloaded, texture should be warned about
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].kind, "glb");
    assert(result.warnings.some((w) => w.includes("Failed to download")));
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: writes metadata.json", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  setMockFetch(async (url: string) => {
    if (url.includes("model.glb")) {
      return createMockResponse(200, Buffer.from("glb"));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
    });

    const job: JobMetadata = {
      jobId: "job-meta",
      taskId: "task-meta",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Metadata test",
      targetFormats: [AssetType.GLB],
      meshName: "test-meta",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-meta",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
      },
    };

    const result = await manager.downloadJob(job, status);

    // Verify metadata file exists
    const metadataPath = join(result.jobFolder, "Metadata", "job.json");
    await stat(metadataPath);
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: writes job.log", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  setMockFetch(async (url: string) => {
    if (url.includes("model.glb")) {
      return createMockResponse(200, Buffer.from("glb"));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
    });

    const job: JobMetadata = {
      jobId: "job-log",
      taskId: "task-log",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Log test",
      targetFormats: [AssetType.GLB],
      meshName: "test-log",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-log",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
      },
    };

    const result = await manager.downloadJob(job, status);

    // Verify log file exists
    const logPath = join(result.jobFolder, "Logs", "job.log");
    await stat(logPath);
  } finally {
    restoreFetch();
  }
});

test("DownloadManager: handles unknown asset keys gracefully", async () => {
  const tempDir = join(
    tmpdir(),
    `test-download-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(tempDir, { recursive: true });

  setMockFetch(async (_url: string) => {
    return createMockResponse(200, Buffer.from("data"));
  });

  try {
    const manager = new DownloadManager({
      downloadDirectory: tempDir,
      ...DEFAULT_DOWNLOAD_CONFIG,
    });

    const job: JobMetadata = {
      jobId: "job-unknown",
      taskId: "task-unknown",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Unknown asset test",
      targetFormats: [AssetType.GLB],
      meshName: "test-unknown",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const status: JobStatus = {
      taskId: "task-unknown",
      state: JobState.Completed,
      rawState: "SUCCEEDED",
      progress: 100,
      modelUrls: {
        glb: "https://example.com/model.glb",
        unknown_format: "https://example.com/model.unknown",
      } as any,
    };

    const result = await manager.downloadJob(job, status);

    // GLB downloaded, unknown format skipped with warning
    assert(result.files.some((f) => f.kind === "glb"));
    assert(result.warnings.some((w) => w.includes("Unknown model asset key")));
  } finally {
    restoreFetch();
  }
});
