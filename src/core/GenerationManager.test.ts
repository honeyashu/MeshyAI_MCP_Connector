/**
 * Unit tests for GenerationManager.
 * Uses a mocked IAI3DProvider to test orchestration logic without hitting real APIs.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { GenerationManager } from "./GenerationManager.js";
import type {
  IAI3DProvider,
  JobStatus,
  DownloadableAsset,
} from "./IAI3DProvider.js";
import { JobState } from "./types.js";
import type { AssetType, ProviderCapabilities } from "./types.js";

/**
 * Mock IAI3DProvider for testing.
 */
class MockAI3DProvider implements IAI3DProvider {
  readonly providerId = "mock-provider";
  readonly capabilities: ProviderCapabilities = {
    supportsNegativePrompt: true,
    supportsBlendFormat: false,
    supportsTurntableVideo: false,
    supportsZipPackage: true,
    supportsWebhooks: false,
    supportsRigging: true,
    supportsAnimation: true,
    supportsTextureRefine: true,
    supportsRigiduv: false,
    supportsRemesh: false,
    supportsConvert: false,
    supportsResize: false,
    supportsRetexture: false,
    supportedFormats: [],
    supportedTextureMaps: [],
    rateLimitPerSecond: 20,
    maxConcurrentJobs: 10,
  };

  private taskCounter: number = 0;
  private taskStates: Map<string, JobStatus> = new Map();

  async textToPreview(): Promise<string> {
    const taskId = `preview-${++this.taskCounter}`;
    this.taskStates.set(taskId, {
      taskId,
      state: JobState.Queued,
      rawState: "PENDING",
      progress: 0,
    });
    return taskId;
  }

  async textToRefine(): Promise<string> {
    const taskId = `refine-${++this.taskCounter}`;
    this.taskStates.set(taskId, {
      taskId,
      state: JobState.Queued,
      rawState: "PENDING",
      progress: 0,
    });
    return taskId;
  }

  async imageToThreeD(): Promise<string> {
    const taskId = `image-${++this.taskCounter}`;
    this.taskStates.set(taskId, {
      taskId,
      state: JobState.Queued,
      rawState: "PENDING",
      progress: 0,
    });
    return taskId;
  }

  async multiImageToThreeD(): Promise<string> {
    const taskId = `multi-${++this.taskCounter}`;
    this.taskStates.set(taskId, {
      taskId,
      state: JobState.Queued,
      rawState: "PENDING",
      progress: 0,
    });
    return taskId;
  }

  async rigModel(): Promise<string> {
    const taskId = `rig-${++this.taskCounter}`;
    this.taskStates.set(taskId, {
      taskId,
      state: JobState.Queued,
      rawState: "PENDING",
      progress: 0,
    });
    return taskId;
  }

  async animateModel(): Promise<string> {
    const taskId = `anim-${++this.taskCounter}`;
    this.taskStates.set(taskId, {
      taskId,
      state: JobState.Queued,
      rawState: "PENDING",
      progress: 0,
    });
    return taskId;
  }

  async getJobStatus(taskId: string): Promise<JobStatus> {
    const status = this.taskStates.get(taskId);
    if (!status) {
      throw new Error(`Task ${taskId} not found`);
    }
    return status;
  }

  async cancelJob(taskId: string): Promise<void> {
    const status = this.taskStates.get(taskId);
    if (status) {
      status.state = JobState.Cancelled;
      status.rawState = "CANCELED";
    }
  }

  async downloadAssets(
    _taskId: string,
    _assetTypes: AssetType[],
    _outputDir: string,
  ): Promise<DownloadableAsset[]> {
    return [];
  }

  async getBalance(): Promise<number> {
    return 100;
  }

  async testConnection(): Promise<void> {
    // no-op: mock is always "connected"
  }
}

test("GenerationManager: textToPreview creates a job and returns task ID", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const taskId = await manager.textToPreview({
    prompt: "A wooden toy car",
  });

  assert(taskId);
  assert(taskId.startsWith("preview-"));
  assert(manager.getJobMetadata(taskId));
});

test("GenerationManager: textToPreview records metadata correctly", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const taskId = await manager.textToPreview({
    prompt: "A red ball",
    modelType: "standard",
  });

  const metadata = manager.getJobMetadata(taskId);
  assert(metadata);
  assert.equal(metadata.prompt, "A red ball");
  assert.equal(metadata.provider, "mock-provider");
  assert.equal(metadata.state, JobState.Queued);
  assert.equal(metadata.progress, 0);
});

test("GenerationManager: textToRefine requires preview task to be complete", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const previewTaskId = await manager.textToPreview({
    prompt: "A toy car",
  });

  // Attempt to refine without completing the preview — should fail
  try {
    await manager.textToRefine(previewTaskId, {
      previewTaskId,
      enablePbr: true,
    });
    assert.fail("Should have thrown");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("Cannot refine"));
  }
});

test("GenerationManager: imageToThreeD creates a job", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const taskId = await manager.imageToThreeD({
    imageUrl: "https://example.com/image.jpg",
    shouldTexture: true,
  });

  assert(taskId);
  assert(taskId.startsWith("image-"));
  const metadata = manager.getJobMetadata(taskId);
  assert(metadata);
  assert.equal(metadata.generationMode, "image-to-3d");
});

test("GenerationManager: multiImageToThreeD creates a job with multiple images", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const taskId = await manager.multiImageToThreeD({
    imageUrls: [
      "https://example.com/1.jpg",
      "https://example.com/2.jpg",
      "https://example.com/3.jpg",
    ],
  });

  assert(taskId);
  assert(taskId.startsWith("multi-"));
  const metadata = manager.getJobMetadata(taskId);
  assert(metadata);
  assert(metadata.prompt.includes("3 images"));
});

test("GenerationManager: rigModel creates a rigging task", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const taskId = await manager.rigModel({
    modelUrl: "https://example.com/model.glb",
    heightMeters: 1.7,
  });

  assert(taskId);
  assert(taskId.startsWith("rig-"));
  const metadata = manager.getJobMetadata(taskId);
  assert(metadata);
  assert.equal(metadata.generationMode, "rigging");
});

test("GenerationManager: animateModel requires rig task to be complete", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const rigTaskId = await manager.rigModel({
    modelUrl: "https://example.com/model.glb",
  });

  // Attempt to animate without completing the rig — should fail
  try {
    await manager.animateModel(rigTaskId, {
      actionId: "idle",
    });
    assert.fail("Should have thrown");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("Cannot animate"));
  }
});

test("GenerationManager: getJobStatus updates metadata", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const taskId = await manager.textToPreview({
    prompt: "A cube",
  });

  // Initially Queued
  const metadata1 = manager.getJobMetadata(taskId);
  assert.equal(metadata1!.state, JobState.Queued);

  // Simulate provider updating the status
  const providerStatus = await provider.getJobStatus(taskId);
  providerStatus.state = JobState.Processing;
  providerStatus.progress = 50;

  // Manager polls and updates
  const status = await manager.getJobStatus(taskId);
  assert.equal(status.state, JobState.Processing);

  // Metadata should be updated
  const metadata2 = manager.getJobMetadata(taskId);
  assert.equal(metadata2!.state, JobState.Processing);
  assert.equal(metadata2!.progress, 50);
});

test("GenerationManager: cancelJob stops and marks task as cancelled", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const taskId = await manager.textToPreview({
    prompt: "A toy",
  });

  // Cancel the job
  await manager.cancelJob(taskId);

  // Check status
  const metadata = manager.getJobMetadata(taskId);
  assert(metadata);
  assert.equal(metadata.state, JobState.Cancelled);
  assert(metadata.completedAt);
});

test("GenerationManager: listJobs returns all tracked task IDs", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const task1 = await manager.textToPreview({
    prompt: "Car",
  });
  const task2 = await manager.imageToThreeD({
    imageUrl: "https://example.com/img.jpg",
  });
  const task3 = await manager.rigModel({
    modelUrl: "https://example.com/model.glb",
  });

  const jobs = manager.listJobs();
  assert(jobs.length >= 3);
  assert(jobs.includes(task1));
  assert(jobs.includes(task2));
  assert(jobs.includes(task3));
});

test("GenerationManager: getJobMetadata returns undefined for unknown task", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const metadata = manager.getJobMetadata("unknown-task-123");
  assert.equal(metadata, undefined);
});

test("GenerationManager: uses provider ID in metadata", async () => {
  const provider = new MockAI3DProvider();
  const manager = new GenerationManager(provider);

  const taskId = await manager.textToPreview({
    prompt: "Sphere",
  });

  const metadata = manager.getJobMetadata(taskId);
  assert.equal(metadata!.provider, "mock-provider");
});
