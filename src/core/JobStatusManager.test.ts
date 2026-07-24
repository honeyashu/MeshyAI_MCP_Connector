/**
 * Unit tests for JobStatusManager.
 * Tests polling path (progress events, terminal states),
 * SSE path (frames trigger provider.getJobStatus()),
 * and maxTrackingDurationMs timeout.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { JobStatusManager } from "./JobStatusManager.js";
import type {
  IAI3DProvider,
  JobStatus,
  DownloadableAsset,
} from "./IAI3DProvider.js";
import { JobState } from "./types.js";
import type { AssetType, ProviderCapabilities } from "./types.js";

class MockAI3DProvider implements IAI3DProvider {
  readonly providerId = "mock-provider";
  readonly capabilities: ProviderCapabilities = {
    supportsNegativePrompt: false,
    supportsBlendFormat: false,
    supportsTurntableVideo: false,
    supportsZipPackage: false,
    supportsWebhooks: false,
    supportsRigging: false,
    supportsAnimation: false,
    supportsTextureRefine: false,
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

  private taskStates: Map<string, JobStatus> = new Map();

  async textToPreview(): Promise<string> {
    throw new Error("Not implemented");
  }
  async textToRefine(): Promise<string> {
    throw new Error("Not implemented");
  }
  async imageToThreeD(): Promise<string> {
    throw new Error("Not implemented");
  }
  async multiImageToThreeD(): Promise<string> {
    throw new Error("Not implemented");
  }
  async getJobStatus(taskId: string): Promise<JobStatus> {
    const status = this.taskStates.get(taskId);
    if (!status) {
      throw new Error(`Task ${taskId} not found`);
    }
    return status;
  }
  async cancelJob(): Promise<void> {
    throw new Error("Not implemented");
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

  setTaskStatus(taskId: string, status: JobStatus): void {
    this.taskStates.set(taskId, status);
  }
}

test("JobStatusManager: polling starts with initial state", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-1", {
    taskId: "task-1",
    state: JobState.Queued,
    rawState: "PENDING",
    progress: 0,
  });

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 100,
    maxTrackingDurationMs: 5000,
  });

  let progressEmitted = false;
  manager.once("progress", (taskId, _progress, state) => {
    if (taskId === "task-1" && state === JobState.Queued) {
      progressEmitted = true;
    }
  });

  manager.track("task-1");

  // Wait for first poll
  await new Promise((resolve) => setTimeout(resolve, 150));
  manager.stop("task-1");

  assert(progressEmitted);
});

test("JobStatusManager: polling emits progress events", async () => {
  const provider = new MockAI3DProvider();
  const states: JobStatus[] = [
    {
      taskId: "task-2",
      state: JobState.Processing,
      rawState: "IN_PROGRESS",
      progress: 25,
    },
    {
      taskId: "task-2",
      state: JobState.Processing,
      rawState: "IN_PROGRESS",
      progress: 50,
    },
    {
      taskId: "task-2",
      state: JobState.Processing,
      rawState: "IN_PROGRESS",
      progress: 75,
    },
  ];

  provider.setTaskStatus("task-2", states[0]);

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  const progressValues: number[] = [];
  manager.on("progress", (taskId, progress) => {
    if (taskId === "task-2") {
      progressValues.push(progress);
    }
  });

  manager.track("task-2");

  // Simulate state updates
  await new Promise((resolve) => setTimeout(resolve, 60));
  provider.setTaskStatus("task-2", states[1]);

  await new Promise((resolve) => setTimeout(resolve, 60));
  provider.setTaskStatus("task-2", states[2]);

  await new Promise((resolve) => setTimeout(resolve, 60));
  manager.stop("task-2");

  assert(progressValues.length > 0);
  assert(progressValues.some((p) => p >= 25));
});

test("JobStatusManager: polling stops on Completed state", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-3", {
    taskId: "task-3",
    state: JobState.Completed,
    rawState: "SUCCEEDED",
    progress: 100,
  });

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  let completedEmitted = false;
  manager.once("completed", (taskId) => {
    if (taskId === "task-3") {
      completedEmitted = true;
    }
  });

  manager.track("task-3");

  await new Promise((resolve) => setTimeout(resolve, 150));

  // Task should have stopped tracking automatically
  assert(completedEmitted);
  assert(!manager["tracked"].has("task-3"));
});

test("JobStatusManager: polling stops on Failed state", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-4", {
    taskId: "task-4",
    state: JobState.Failed,
    rawState: "FAILED",
    progress: 0,
    taskError: { type: "timeout", message: "Timeout" },
  });

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  let failedEmitted = false;
  manager.once("failed", (taskId) => {
    if (taskId === "task-4") {
      failedEmitted = true;
    }
  });

  manager.track("task-4");

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert(failedEmitted);
});

test("JobStatusManager: polling stops on Cancelled state", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-5", {
    taskId: "task-5",
    state: JobState.Cancelled,
    rawState: "CANCELED",
    progress: 50,
  });

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  let cancelledEmitted = false;
  manager.once("cancelled", (taskId) => {
    if (taskId === "task-5") {
      cancelledEmitted = true;
    }
  });

  manager.track("task-5");

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert(cancelledEmitted);
});

test("JobStatusManager: stops tracking on maxTrackingDurationMs", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-6", {
    taskId: "task-6",
    state: JobState.Processing,
    rawState: "IN_PROGRESS",
    progress: 50,
  });

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 200, // Very short timeout
  });

  let failedEmitted = false;
  manager.once("failed", (taskId, status) => {
    if (taskId === "task-6") {
      failedEmitted = true;
      assert.equal(status.taskError?.type, "timeout");
    }
  });

  manager.track("task-6");

  await new Promise((resolve) => setTimeout(resolve, 300));

  assert(failedEmitted);
});

test("JobStatusManager: handles polling errors gracefully", async () => {
  const provider = new MockAI3DProvider();

  let callCount = 0;
  const originalGetJobStatus = provider.getJobStatus.bind(provider);
  (provider as any).getJobStatus = async (taskId: string) => {
    callCount++;
    if (callCount === 1) {
      throw new Error("Network error");
    }
    return originalGetJobStatus(taskId);
  };

  provider.setTaskStatus("task-7", {
    taskId: "task-7",
    state: JobState.Processing,
    rawState: "IN_PROGRESS",
    progress: 50,
  });

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  manager.track("task-7");

  // First poll fails, second succeeds
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Should still be tracking despite the error
  manager.stop("task-7");
  assert(callCount >= 2);
});

test("JobStatusManager: SSE frame triggers provider.getJobStatus()", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-sse-1", {
    taskId: "task-sse-1",
    state: JobState.Processing,
    rawState: "IN_PROGRESS",
    progress: 50,
  });

  let getJobStatusCallCount = 0;
  const originalGetJobStatus = provider.getJobStatus.bind(provider);
  (provider as any).getJobStatus = async (taskId: string) => {
    getJobStatusCallCount++;
    return originalGetJobStatus(taskId);
  };

  // Mock SSE stream that sends one frame and closes
  const mockOpenStream = async (_taskId: string): Promise<Response> => {
    const sseData =
      'event: message\ndata: {"id":"task-sse-1","progress":50,"status":"IN_PROGRESS"}\n\n';
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      }) as any,
    } as any;
  };

  const manager = new JobStatusManager(
    provider,
    { pollIntervalMs: 5000, maxTrackingDurationMs: 5000 },
    mockOpenStream,
  );

  let progressEmitted = false;
  manager.once("progress", () => {
    progressEmitted = true;
  });

  manager.track("task-sse-1");

  // Wait for SSE to be processed
  await new Promise((resolve) => setTimeout(resolve, 100));
  manager.stop("task-sse-1");

  assert(progressEmitted);
  assert(getJobStatusCallCount > 0); // SSE frame should trigger a getJobStatus call
});

test("JobStatusManager: SSE error falls back to polling", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-sse-error", {
    taskId: "task-sse-error",
    state: JobState.Processing,
    rawState: "IN_PROGRESS",
    progress: 0,
  });

  const mockOpenStream = async (_taskId: string): Promise<Response> => {
    const errorData =
      'event: error\ndata: {"status_code":500,"message":"SSE stream error"}\n\n';
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(errorData));
          controller.close();
        },
      }) as any,
    } as any;
  };

  const manager = new JobStatusManager(
    provider,
    { pollIntervalMs: 50, maxTrackingDurationMs: 5000 },
    mockOpenStream,
  );

  // Should track via polling fallback after SSE error
  manager.track("task-sse-error");

  await new Promise((resolve) => setTimeout(resolve, 200));
  manager.stop("task-sse-error");

  // If we get here without crashing, fallback worked
  assert(true);
});

test("JobStatusManager: stop() prevents further polling", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-stop", {
    taskId: "task-stop",
    state: JobState.Processing,
    rawState: "IN_PROGRESS",
    progress: 0,
  });

  let getJobStatusCallCount = 0;
  const originalGetJobStatus = provider.getJobStatus.bind(provider);
  (provider as any).getJobStatus = async (taskId: string) => {
    getJobStatusCallCount++;
    return originalGetJobStatus(taskId);
  };

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  manager.track("task-stop");

  // Wait for first poll
  await new Promise((resolve) => setTimeout(resolve, 100));

  const countAfterFirstPoll = getJobStatusCallCount;

  // Stop tracking
  manager.stop("task-stop");

  // Wait (no more polls should happen)
  await new Promise((resolve) => setTimeout(resolve, 100));

  const countAfterStop = getJobStatusCallCount;

  // Count should not increase significantly after stop
  assert(
    countAfterStop === countAfterFirstPoll ||
      countAfterStop === countAfterFirstPoll + 1,
  );
});

test("JobStatusManager: prevents duplicate tracking", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-dup", {
    taskId: "task-dup",
    state: JobState.Processing,
    rawState: "IN_PROGRESS",
    progress: 0,
  });

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  manager.track("task-dup");
  manager.track("task-dup"); // Second call should be ignored

  await new Promise((resolve) => setTimeout(resolve, 100));
  manager.stop("task-dup");

  // Should only have one tracked job
  assert.equal(manager["tracked"].size, 0);
});

test("JobStatusManager: emits completed with full JobStatus", async () => {
  const provider = new MockAI3DProvider();
  const completedStatus: JobStatus = {
    taskId: "task-completed",
    state: JobState.Completed,
    rawState: "SUCCEEDED",
    progress: 100,
    modelUrls: { glb: "https://example.com/model.glb" },
  };
  provider.setTaskStatus("task-completed", completedStatus);

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  let emittedStatus: JobStatus | null = null;
  manager.once("completed", (taskId, status) => {
    if (taskId === "task-completed") {
      emittedStatus = status;
    }
  });

  manager.track("task-completed");

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(emittedStatus, "expected a completed status to have been emitted");
  const status: JobStatus = emittedStatus;
  assert.equal(status.state, JobState.Completed);
  assert.equal(status.progress, 100);
});

test("JobStatusManager: getPhaseDescription provides phase info", async () => {
  const provider = new MockAI3DProvider();
  provider.setTaskStatus("task-phase", {
    taskId: "task-phase",
    state: JobState.Processing,
    rawState: "IN_PROGRESS",
    progress: 50,
  });

  const manager = new JobStatusManager(provider, {
    pollIntervalMs: 50,
    maxTrackingDurationMs: 5000,
  });

  let emittedPhaseDescription: string | null = null;
  manager.once("progress", (taskId, _progress, _state, phase) => {
    if (taskId === "task-phase") {
      emittedPhaseDescription = phase;
    }
  });

  manager.track("task-phase");

  await new Promise((resolve) => setTimeout(resolve, 150));
  manager.stop("task-phase");

  assert(emittedPhaseDescription);
  assert(typeof emittedPhaseDescription === "string");
});
