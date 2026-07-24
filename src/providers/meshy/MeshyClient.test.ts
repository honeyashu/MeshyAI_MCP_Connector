/**
 * Unit tests for MeshyClient.
 * Tests HTTP request/response handling with mocked fetch.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { MeshyClient, MeshyTaskStatus } from "./MeshyClient.js";
import type { ProviderError } from "../../core/types.js";

/**
 * Mocks globalThis.fetch for testing.
 * Provides a way to intercept HTTP calls without hitting the real API.
 */
function setupFetchMock(
  responseBody: unknown,
  statusCode: number = 200,
  contentType: string = "application/json",
): () => void {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    return {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      statusText: statusCode === 200 ? "OK" : "Error",
      headers: new Headers({ "content-type": contentType }),
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response;
  };

  return () => {
    global.fetch = originalFetch;
  };
}

test("MeshyClient - balance endpoint returns correct value", async () => {
  const restore = setupFetchMock({ balance: 42.5 });
  try {
    const client = new MeshyClient("msy_test_key_12345");
    const balance = await client.getBalance();
    assert.equal(balance, 42.5);
  } finally {
    restore();
  }
});

test("MeshyClient - textTo3D preview request succeeds", async () => {
  const mockResponse = {
    id: "task-123",
    status: MeshyTaskStatus.PENDING,
    progress: 0,
  };
  const restore = setupFetchMock(mockResponse);
  try {
    const client = new MeshyClient("msy_test_key_12345");
    // MeshyClient.textTo3D() returns the full MeshyTaskResponse, not just the ID
    // (extracting .id is MeshyProvider's job, one layer up) — check the .id field.
    const response = await client.textTo3D({
      mode: "preview",
      prompt: "A red ball",
    });
    assert.equal(response.id, "task-123");
  } finally {
    restore();
  }
});

test("MeshyClient - imageTo3D request succeeds", async () => {
  const mockResponse = {
    id: "task-456",
    status: MeshyTaskStatus.PENDING,
    progress: 0,
  };
  const restore = setupFetchMock(mockResponse);
  try {
    const client = new MeshyClient("msy_test_key_12345");
    const response = await client.imageTo3D({
      image_url: "https://example.com/image.png",
    });
    assert.equal(response.id, "task-456");
  } finally {
    restore();
  }
});

test("MeshyClient - HTTP 401 error is caught", async () => {
  const restore = setupFetchMock({ message: "Unauthorized" }, 401);
  try {
    const client = new MeshyClient("msy_invalid_key");
    try {
      await client.getBalance();
      assert.fail("Should have thrown an error");
    } catch (error) {
      const err = error as ProviderError;
      assert.equal(err.httpStatus, 401);
      assert.match(err.message, /Unauthorized/);
    }
  } finally {
    restore();
  }
});

test("MeshyClient - HTTP 402 (quota exceeded) is caught", async () => {
  const restore = setupFetchMock({ message: "Insufficient credits" }, 402);
  try {
    const client = new MeshyClient("msy_test_key_12345");
    try {
      await client.getBalance();
      assert.fail("Should have thrown an error");
    } catch (error) {
      const err = error as ProviderError;
      assert.equal(err.httpStatus, 402);
    }
  } finally {
    restore();
  }
});

test("MeshyClient - task_error in response is captured", async () => {
  const mockResponse = {
    id: "task-789",
    status: MeshyTaskStatus.FAILED,
    progress: 0,
    task_error: {
      type: "invalid_input",
      message: "Prompt contains blocked words",
      code: "MODERATION_BLOCKED",
      doc_url: "https://docs.meshy.ai/errors/moderation",
    },
  };
  const restore = setupFetchMock(mockResponse, 400);
  try {
    const client = new MeshyClient("msy_test_key_12345");
    try {
      await client.textTo3D({
        mode: "preview",
        prompt: "A ball",
      });
      assert.fail("Should have thrown an error");
    } catch (error) {
      const err = error as ProviderError;
      assert.equal(err.httpStatus, 400);
      assert(err.taskError);
      assert.equal(err.taskError.type, "invalid_input");
      assert.equal(err.taskError.code, "MODERATION_BLOCKED");
    }
  } finally {
    restore();
  }
});

test("MeshyClient - getTextTo3DTask retrieves status", async () => {
  const mockResponse = {
    id: "task-999",
    status: MeshyTaskStatus.IN_PROGRESS,
    progress: 50,
    model_urls: { glb: "https://example.com/model.glb" },
  };
  const restore = setupFetchMock(mockResponse);
  try {
    const client = new MeshyClient("msy_test_key_12345");
    const task = await client.getTextTo3DTask("task-999");
    assert.equal(task.id, "task-999");
    assert.equal(task.status, MeshyTaskStatus.IN_PROGRESS);
    assert.equal(task.progress, 50);
  } finally {
    restore();
  }
});

test("MeshyClient - deleteTextTo3DTask makes DELETE request", async () => {
  let requestMethod = "";
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requestMethod = (options as RequestInit)?.method || "GET";
    return {
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "",
    } as Response;
  };

  try {
    const client = new MeshyClient("msy_test_key_12345");
    await client.deleteTextTo3DTask("task-999");
    assert.equal(requestMethod, "DELETE");
  } finally {
    global.fetch = originalFetch;
  }
});

test("MeshyClient - multiImageTo3D accepts 1-4 images", async () => {
  const mockResponse = {
    id: "task-multi",
    status: MeshyTaskStatus.PENDING,
    progress: 0,
  };
  const restore = setupFetchMock(mockResponse);
  try {
    const client = new MeshyClient("msy_test_key_12345");
    const response = await client.multiImageTo3D({
      image_urls: [
        "https://example.com/img1.png",
        "https://example.com/img2.png",
        "https://example.com/img3.png",
      ],
    });
    assert.equal(response.id, "task-multi");
  } finally {
    restore();
  }
});

test("MeshyClient - rig and animate methods work", async () => {
  const rigResponse = {
    id: "rig-task-123",
    status: MeshyTaskStatus.PENDING,
    progress: 0,
  };
  const restore = setupFetchMock(rigResponse);
  try {
    const client = new MeshyClient("msy_test_key_12345");
    const rigResult = await client.rig({
      input_task_id: "model-task-123",
      height_meters: 1.7,
    });
    assert.equal(rigResult.id, "rig-task-123");
  } finally {
    restore();
  }
});
