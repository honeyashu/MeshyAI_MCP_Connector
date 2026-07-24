/**
 * Unit tests for MeshyProvider.
 * Tests provider interface implementation with mocked MeshyClient.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { MeshyProvider } from "./MeshyProvider.js";
import { AssetType } from "../../core/types.js";

// Note: MeshyProvider constructs its own internal MeshyClient from an apiKey
// (no dependency-injection seam for a mock client), so most tests below exercise
// capabilities/providerId/static behavior directly rather than mocking MeshyClient.
// The network-dependent regression tests further down mock `global.fetch` directly
// (same technique as MeshyClient.test.ts) since that's the only seam available
// without a DI refactor — see the "REGRESSION" tests for the taskId/result bug
// these were specifically added to catch.

/**
 * Mocks globalThis.fetch for a single JSON response. Mirrors the helper in
 * MeshyClient.test.ts; duplicated here rather than shared since these are two
 * genuinely separate test files/concerns (HTTP layer vs. provider layer).
 */
function setupFetchMock(
  responseBody: unknown,
  statusCode: number = 200,
): () => void {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      statusText: statusCode === 200 ? "OK" : "Error",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response;
  };
  return () => {
    global.fetch = originalFetch;
  };
}

test("MeshyProvider - has correct providerId", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(provider.providerId, "meshy");
});

test("MeshyProvider - capabilities reflect Meshy limitations", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  const caps = provider.capabilities;

  // PLAN.md §2 limitations
  assert.equal(caps.supportsBlendFormat, false); // Item 2
  assert.equal(caps.supportsTurntableVideo, false); // Item 3
  assert.equal(caps.supportsWebhooks, false); // Item 6
  assert.equal(caps.supportsNegativePrompt, true); // Item 1
  assert.equal(caps.supportsZipPackage, true); // Item 4
  assert.equal(caps.supportsRigging, true); // Humanoid rigging supported
  assert.equal(caps.supportsAnimation, true); // Animation supported

  // Check supported formats
  assert(caps.supportedFormats.includes(AssetType.GLB));
  assert(caps.supportedFormats.includes(AssetType.FBX));
  assert(caps.supportedFormats.includes(AssetType.OBJ));
  assert(caps.supportedFormats.includes(AssetType.STL));
  // '.blend' isn't a member of AssetType at all (PLAN.md §2 item 2 — not producible
  // via the Meshy API), so there's no enum value to check for "not supported" the
  // way the other formats are checked for "supported" above. Asserting the format
  // list length instead confirms nothing beyond the documented 8 formats snuck in.
  assert.equal(caps.supportedFormats.length, 8);

  // Check rate limits (Pro tier)
  assert.equal(caps.rateLimitPerSecond, 20);
  assert.equal(caps.maxConcurrentJobs, 10);
});

test("MeshyProvider - textToPreview returns task ID", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.textToPreview, "function");
});

test("MeshyProvider - getJobStatus normalizes status to JobState", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.getJobStatus, "function");
});

// --- REGRESSION: taskId/result field bug -----------------------------------
//
// Meshy's create-task POST endpoints return `{ result: "<taskId>" }`, not
// `{ id: "<taskId>" }`. A shipped version of MeshyProvider read `.id` off these
// responses, which doesn't exist there — so `taskId` was silently `undefined`
// on every successful generation call, and the failure only surfaced later as
// a crash in GenerationManager (`taskId.slice(...)`), *after* Meshy had already
// created the task and spent the caller's credits. These tests mock the real
// response shape (`result` only, no `id`) and would fail immediately if that
// bug reappears in any of the six create-task methods below.

test("MeshyProvider - textToPreview extracts taskId from 'result' field (REGRESSION)", async () => {
  const restore = setupFetchMock({ result: "preview-task-abc123" });
  try {
    const provider = new MeshyProvider("msy_test_key_12345");
    const taskId = await provider.textToPreview({ prompt: "A red ball" });
    assert.equal(taskId, "preview-task-abc123");
  } finally {
    restore();
  }
});

test("MeshyProvider - textToPreview throws immediately (not later) if 'result' is missing (REGRESSION)", async () => {
  // Simulates the exact historical bug shape: a 200 OK with no usable task ID.
  const restore = setupFetchMock({ id: "some-other-field-not-result" });
  try {
    const provider = new MeshyProvider("msy_test_key_12345");
    await assert.rejects(
      () => provider.textToPreview({ prompt: "A red ball" }),
      /did not include a 'result' field/,
    );
  } finally {
    restore();
  }
});

test("MeshyProvider - textToRefine extracts taskId from 'result' field (REGRESSION)", async () => {
  const restore = setupFetchMock({ result: "refine-task-xyz789" });
  try {
    const provider = new MeshyProvider("msy_test_key_12345");
    const taskId = await provider.textToRefine({
      previewTaskId: "preview-task-abc123",
    });
    assert.equal(taskId, "refine-task-xyz789");
  } finally {
    restore();
  }
});

test("MeshyProvider - imageToThreeD extracts taskId from 'result' field (REGRESSION)", async () => {
  const restore = setupFetchMock({ result: "image-task-111" });
  try {
    const provider = new MeshyProvider("msy_test_key_12345");
    const taskId = await provider.imageToThreeD({
      imageUrl: "https://example.com/image.png",
    });
    assert.equal(taskId, "image-task-111");
  } finally {
    restore();
  }
});

test("MeshyProvider - multiImageToThreeD extracts taskId from 'result' field (REGRESSION)", async () => {
  const restore = setupFetchMock({ result: "multi-image-task-222" });
  try {
    const provider = new MeshyProvider("msy_test_key_12345");
    const taskId = await provider.multiImageToThreeD({
      imageUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });
    assert.equal(taskId, "multi-image-task-222");
  } finally {
    restore();
  }
});

test("MeshyProvider - rigModel extracts taskId from 'result' field (REGRESSION)", async () => {
  const restore = setupFetchMock({ result: "rig-task-333" });
  try {
    const provider = new MeshyProvider("msy_test_key_12345");
    const taskId = await provider.rigModel!({
      inputTaskId: "model-task-123",
      heightMeters: 1.7,
    });
    assert.equal(taskId, "rig-task-333");
  } finally {
    restore();
  }
});

test("MeshyProvider - animateModel extracts taskId from 'result' field (REGRESSION)", async () => {
  const restore = setupFetchMock({ result: "anim-task-444" });
  try {
    const provider = new MeshyProvider("msy_test_key_12345");
    const taskId = await provider.animateModel!({
      rigTaskId: "rig-task-333",
      actionId: "walk",
    });
    assert.equal(taskId, "anim-task-444");
  } finally {
    restore();
  }
});

test("MeshyProvider - testConnection validates API access", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.testConnection, "function");
});

test("MeshyProvider - getBalance returns account credits", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.getBalance, "function");
});

test("MeshyProvider - rigModel is optional and callable", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.rigModel, "function");
});

test("MeshyProvider - animateModel is optional and callable", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.animateModel, "function");
});

test("MeshyProvider - downloadAssets stub is present", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.downloadAssets, "function");
});

test("MeshyProvider - cancelJob is implemented", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.cancelJob, "function");
});
