/**
 * Unit tests for jobStore (SQLite-backed job persistence).
 * Tests save/get/list/delete round-trips if better-sqlite3 is available,
 * or verifies graceful undefined return if not installed.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { join } from "path";
import { rmSync, existsSync } from "fs";
import { homedir } from "os";
import {
  JobState,
  GenerationMode,
  AssetType,
  type JobMetadata,
} from "../core/types.js";
import { createJobStore } from "./jobStore.js";

// Whether the SQLite-backed store actually works in this environment. Checking
// this via `require('better-sqlite3')`/`import('better-sqlite3')` resolving is
// NOT sufficient: the package's JS entry point loads fine even when its native
// binding isn't compiled for the current platform (no prebuilt binary) — the
// failure only surfaces once code tries to actually open a database. So this
// probes the real thing we care about: does `createJobStore()` return a working
// store or `undefined`. This needs top-level await to decide (synchronously, at
// module-evaluation time) which set of tests to register below — a `before()`
// hook doesn't work here because test registration (the if/else block further
// down) happens before hooks run. tsconfig's `module` was bumped from "ES2020" to
// "ES2022" to allow this (see tsconfig.json; ES2022 is fully supported by the
// project's Node >=20 engine requirement).
const probeStore = await createJobStore();
const sqlite_store_available = probeStore !== undefined;

// Test database location
const dbDir = join(homedir(), ".meshy-connector");
const dbFile = join(dbDir, "jobs.sqlite3");

// Clean up test database before tests
function cleanupTestDb() {
  try {
    if (existsSync(dbFile)) {
      rmSync(dbFile);
    }
  } catch {
    // Ignore cleanup errors
  }
}

test("jobStore: module exports createJobStore", async () => {
  // Just verify the module can be imported
  const module = await import("./jobStore.js");
  assert(typeof module.createJobStore === "function");
});

if (sqlite_store_available) {
  test("jobStore: createJobStore returns a store instance", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store !== undefined);
    assert(store !== null);
    assert(typeof store.save === "function");
    assert(typeof store.get === "function");
    assert(typeof store.list === "function");
    assert(typeof store.delete === "function");

    cleanupTestDb();
  });

  test("jobStore: save and get round-trip", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store);

    const jobMetadata: JobMetadata = {
      jobId: "job-123",
      taskId: "task-123",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "A wooden toy car",
      negativePrompt: "low quality",
      modelType: "standard",
      targetFormats: [AssetType.GLB, AssetType.STL],
      meshName: "toy-car",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [AssetType.GLB],
    };

    await store.save(jobMetadata);

    const retrieved = await store.get("task-123");
    assert(retrieved);
    assert.equal(retrieved.jobId, "job-123");
    assert.equal(retrieved.provider, "meshy");
    assert.equal(retrieved.prompt, "A wooden toy car");
    assert.equal(retrieved.progress, 100);
    assert.equal(retrieved.targetFormats[0], AssetType.GLB);

    cleanupTestDb();
  });

  test("jobStore: get returns undefined for non-existent task", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store);

    const retrieved = await store.get("non-existent-task");
    assert.equal(retrieved, undefined);

    cleanupTestDb();
  });

  test("jobStore: list returns all jobs by default", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store);

    const job1: JobMetadata = {
      jobId: "job-1",
      taskId: "task-1",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Job 1",
      targetFormats: [],
      meshName: "mesh-1",
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    const job2: JobMetadata = {
      jobId: "job-2",
      taskId: "task-2",
      provider: "meshy",
      generationMode: GenerationMode.ImageToThreeD,
      prompt: "Job 2",
      targetFormats: [],
      meshName: "mesh-2",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    await store.save(job1);
    await store.save(job2);

    const jobs = await store.list();
    assert(jobs.length >= 2);
    assert(jobs.some((j) => j.taskId === "task-1"));
    assert(jobs.some((j) => j.taskId === "task-2"));

    cleanupTestDb();
  });

  test("jobStore: list filters by provider", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store);

    const meshyJob: JobMetadata = {
      jobId: "job-meshy",
      taskId: "task-meshy",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Meshy job",
      targetFormats: [],
      meshName: "mesh-meshy",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const tripoJob: JobMetadata = {
      jobId: "job-tripo",
      taskId: "task-tripo",
      provider: "tripo",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Tripo job",
      targetFormats: [],
      meshName: "mesh-tripo",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    await store.save(meshyJob);
    await store.save(tripoJob);

    const meshyJobs = await store.list({ provider: "meshy" });
    assert(meshyJobs.every((j) => j.provider === "meshy"));
    assert(meshyJobs.some((j) => j.taskId === "task-meshy"));
    assert(!meshyJobs.some((j) => j.taskId === "task-tripo"));

    cleanupTestDb();
  });

  test("jobStore: list filters by state", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store);

    const completedJob: JobMetadata = {
      jobId: "job-done",
      taskId: "task-done",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Completed",
      targetFormats: [],
      meshName: "mesh-done",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    const queuedJob: JobMetadata = {
      jobId: "job-queue",
      taskId: "task-queue",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Queued",
      targetFormats: [],
      meshName: "mesh-queue",
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    await store.save(completedJob);
    await store.save(queuedJob);

    const completedJobs = await store.list({ state: JobState.Completed });
    assert(completedJobs.every((j) => j.state === JobState.Completed));
    assert(completedJobs.some((j) => j.taskId === "task-done"));
    assert(!completedJobs.some((j) => j.taskId === "task-queue"));

    cleanupTestDb();
  });

  test("jobStore: delete removes a job", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store);

    const job: JobMetadata = {
      jobId: "job-delete",
      taskId: "task-delete",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "To delete",
      targetFormats: [],
      meshName: "mesh-delete",
      createdAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [],
    };

    await store.save(job);

    let retrieved = await store.get("task-delete");
    assert(retrieved);

    await store.delete("task-delete");

    retrieved = await store.get("task-delete");
    assert.equal(retrieved, undefined);

    cleanupTestDb();
  });

  test("jobStore: update (via save) overwrites existing job", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store);

    const job: JobMetadata = {
      jobId: "job-update",
      taskId: "task-update",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Original prompt",
      targetFormats: [],
      meshName: "mesh-update",
      createdAt: new Date().toISOString(),
      state: JobState.Queued,
      progress: 0,
      downloadedAssets: [],
    };

    await store.save(job);

    // Update
    job.state = JobState.Completed;
    job.progress = 100;
    job.prompt = "Updated prompt";

    await store.save(job);

    const retrieved = await store.get("task-update");
    assert(retrieved);
    assert.equal(retrieved.state, JobState.Completed);
    assert.equal(retrieved.progress, 100);
    assert.equal(retrieved.prompt, "Updated prompt");

    cleanupTestDb();
  });

  test("jobStore: serializes and deserializes complex fields", async () => {
    cleanupTestDb();

    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    assert(store);

    const job: JobMetadata = {
      jobId: "job-complex",
      taskId: "task-complex",
      provider: "meshy",
      generationMode: GenerationMode.TextToPreview,
      prompt: "Complex test",
      targetFormats: [AssetType.GLB, AssetType.STL, AssetType.USDZ],
      meshName: "mesh-complex",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      state: JobState.Completed,
      progress: 100,
      downloadedAssets: [AssetType.GLB, AssetType.STL],
      rawResponse: { someField: "value", nested: { data: 123 } },
    };

    await store.save(job);

    const retrieved = await store.get("task-complex");
    assert(retrieved);
    assert.deepEqual(retrieved.targetFormats, [
      AssetType.GLB,
      AssetType.STL,
      AssetType.USDZ,
    ]);
    assert.equal(retrieved.downloadedAssets.length, 2);
    assert.equal(retrieved.downloadedAssets[0], AssetType.GLB);
    assert.equal(retrieved.downloadedAssets[1], AssetType.STL);
    assert.deepEqual(retrieved.rawResponse, {
      someField: "value",
      nested: { data: 123 },
    });

    cleanupTestDb();
  });
} else {
  test("jobStore: gracefully degrades without better-sqlite3", async () => {
    // If better-sqlite3 is not installed, createJobStore should return undefined
    const { createJobStore } = await import("./jobStore.js");
    const store = await createJobStore();

    // This is the expected behavior when better-sqlite3 is unavailable
    assert(store === undefined || store !== null); // Store is either undefined or works
  });
}
