/**
 * Unit tests for RetryPolicy.
 * Tests isTransientError() for both ProviderError and plain Error shapes,
 * and withRetry() for retry counts, backoff, and max retries.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  isTransientError,
  withRetry,
  type BackoffConfig,
} from "./RetryPolicy.js";
import type { ProviderError } from "./types.js";

test("isTransientError: ProviderError with 5xx status is transient", () => {
  const error: ProviderError = {
    httpStatus: 500,
    message: "Internal server error",
  };
  assert(isTransientError(error));
});

test("isTransientError: ProviderError with 503 status is transient", () => {
  const error: ProviderError = {
    httpStatus: 503,
    message: "Service unavailable",
  };
  assert(isTransientError(error));
});

test("isTransientError: ProviderError with 429 (rate limit) is transient", () => {
  const error: ProviderError = {
    httpStatus: 429,
    message: "Too many requests",
  };
  assert(isTransientError(error));
});

test("isTransientError: ProviderError with taskError.timeout is transient", () => {
  const error: ProviderError = {
    httpStatus: 408,
    message: "Request timeout",
    taskError: { type: "timeout", message: "Task timed out" },
  };
  assert(isTransientError(error));
});

test("isTransientError: ProviderError with taskError.service_unavailable is transient", () => {
  const error: ProviderError = {
    httpStatus: 503,
    message: "Service down",
    taskError: {
      type: "service_unavailable",
      message: "Service temporarily unavailable",
    },
  };
  assert(isTransientError(error));
});

test("isTransientError: ProviderError with taskError.server_error is transient", () => {
  const error: ProviderError = {
    httpStatus: 500,
    message: "Server error",
    taskError: { type: "server_error", message: "Unexpected server error" },
  };
  assert(isTransientError(error));
});

test("isTransientError: ProviderError with 400 status is NOT transient", () => {
  const error: ProviderError = {
    httpStatus: 400,
    message: "Bad request",
  };
  assert(!isTransientError(error));
});

test("isTransientError: ProviderError with 401 status is NOT transient", () => {
  const error: ProviderError = {
    httpStatus: 401,
    message: "Unauthorized",
  };
  assert(!isTransientError(error));
});

test("isTransientError: ProviderError with taskError.invalid_input is NOT transient", () => {
  const error: ProviderError = {
    httpStatus: 400,
    message: "Bad input",
    taskError: { type: "invalid_input", message: "Invalid prompt" },
  };
  assert(!isTransientError(error));
});

test("isTransientError: ProviderError with taskError.moderation_blocked is NOT transient", () => {
  const error: ProviderError = {
    httpStatus: 403,
    message: "Forbidden",
    taskError: { type: "moderation_blocked", message: "Content blocked" },
  };
  assert(!isTransientError(error));
});

test('isTransientError: Plain Error with "timeout" in message is transient', () => {
  const error = new Error("Request timeout after 30000ms");
  assert(isTransientError(error));
});

test('isTransientError: Plain Error with "service_unavailable" in message is transient', () => {
  const error = new Error("service_unavailable");
  assert(isTransientError(error));
});

test('isTransientError: Plain Error with "ECONNREFUSED" is transient', () => {
  const error = new Error("ECONNREFUSED: Connection refused");
  assert(isTransientError(error));
});

test('isTransientError: Plain Error with "ENOTFOUND" is transient', () => {
  const error = new Error("ENOTFOUND: api.example.com");
  assert(isTransientError(error));
});

test('isTransientError: Plain Error with "network" in message is transient', () => {
  const error = new Error("Network unreachable");
  assert(isTransientError(error));
});

test("isTransientError: AbortError is transient", () => {
  const error = new Error("Aborted");
  error.name = "AbortError";
  assert(isTransientError(error));
});

test("isTransientError: TypeError (fetch network error) is transient", () => {
  const error = new TypeError("Failed to fetch");
  assert(isTransientError(error));
});

test('isTransientError: Plain Error with "invalid" is NOT transient', () => {
  const error = new Error("Invalid input");
  assert(!isTransientError(error));
});

test("isTransientError: null/undefined returns false", () => {
  assert(!isTransientError(null));
  assert(!isTransientError(undefined));
  assert(!isTransientError({}));
});

test("withRetry: succeeds on first attempt", async () => {
  const fn = async () => "success";
  const result = await withRetry(fn, {
    maxRetries: 0,
    initialDelayMs: 1,
    maxDelayMs: 1,
  });
  assert.equal(result, "success");
});

test("withRetry: retries transient errors up to maxRetries", async () => {
  let attempts = 0;
  const fn = async () => {
    attempts++;
    if (attempts < 3) {
      throw new Error("timeout");
    }
    return "success";
  };
  const result = await withRetry(fn, {
    maxRetries: 3,
    initialDelayMs: 1,
    maxDelayMs: 1,
  });
  assert.equal(result, "success");
  assert.equal(attempts, 3);
});

test("withRetry: fails immediately on non-transient errors", async () => {
  let attempts = 0;
  const fn = async () => {
    attempts++;
    throw new Error("invalid input");
  };
  try {
    await withRetry(fn, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 });
    assert.fail("Should have thrown");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("invalid input"));
    assert.equal(attempts, 1); // should only try once
  }
});

test("withRetry: respects maxRetries limit", async () => {
  let attempts = 0;
  const fn = async () => {
    attempts++;
    throw new Error("timeout");
  };
  try {
    await withRetry(fn, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 });
    assert.fail("Should have thrown");
  } catch (error) {
    assert(error instanceof Error);
    assert.equal(attempts, 3); // 0, 1, 2 (maxRetries + 1)
  }
});

test("withRetry: applies exponential backoff", async () => {
  const delays: number[] = [];
  const originalSetTimeout = global.setTimeout;

  // Mock setTimeout to capture delays
  (global as any).setTimeout = (fn: () => void, delayMs: number) => {
    delays.push(delayMs);
    // Immediately call the function to avoid real delays
    fn();
    return 0;
  };

  try {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("timeout");
      }
      return "success";
    };

    const config: BackoffConfig = {
      maxRetries: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      jitter: false,
    };

    await withRetry(fn, config);

    // Should have exponential backoff: 100ms, 200ms
    assert.equal(delays.length, 2);
    assert(delays[0] >= 100 && delays[0] <= 100); // 100 * 2^0
    assert(delays[1] >= 200 && delays[1] <= 200); // 100 * 2^1
  } finally {
    (global as any).setTimeout = originalSetTimeout;
  }
});

test("withRetry: caps backoff at maxDelayMs", async () => {
  const delays: number[] = [];
  const originalSetTimeout = global.setTimeout;

  (global as any).setTimeout = (fn: () => void, delayMs: number) => {
    delays.push(delayMs);
    fn();
    return 0;
  };

  try {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts <= 5) {
        throw new Error("timeout");
      }
      return "success";
    };

    const config: BackoffConfig = {
      maxRetries: 5,
      initialDelayMs: 100,
      maxDelayMs: 500,
      jitter: false,
    };

    await withRetry(fn, config);

    // Delays: 100, 200, 400, 500 (capped), 500 (capped)
    assert.equal(delays.length, 5);
    assert(delays[0] <= 100);
    assert(delays[1] <= 200);
    assert(delays[2] <= 400);
    assert(delays[3] <= 500); // capped
    assert(delays[4] <= 500); // capped
  } finally {
    (global as any).setTimeout = originalSetTimeout;
  }
});

test("withRetry: applies jitter when enabled", async () => {
  const delays: number[] = [];
  const originalSetTimeout = global.setTimeout;

  (global as any).setTimeout = (fn: () => void, delayMs: number) => {
    delays.push(delayMs);
    fn();
    return 0;
  };

  try {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("timeout");
      }
      return "success";
    };

    const config: BackoffConfig = {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 1000,
      jitter: true,
    };

    await withRetry(fn, config);

    // With jitter, delays should be between 50% and 100% of the calculated value
    // First retry: 1000 * (0.5 + random*0.5) = 500-1000
    // Second retry: 2000 * (0.5 + random*0.5) = 1000 (capped)
    assert.equal(delays.length, 2);
    assert(delays[0] >= 500 && delays[0] <= 1000);
    assert(delays[1] <= 1000);
  } finally {
    (global as any).setTimeout = originalSetTimeout;
  }
});

test("withRetry: passes context to logger", async () => {
  // Note: this test captures context passed to withRetry but doesn't fully verify
  // logging (that's the Logger's responsibility). Just verify context is accepted.
  let attempts = 0;
  const fn = async () => {
    attempts++;
    if (attempts < 2) {
      throw new Error("timeout");
    }
    return "success";
  };

  const result = await withRetry(
    fn,
    { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 },
    { jobId: "test-job-123", operation: "test-op" },
  );

  assert.equal(result, "success");
});
