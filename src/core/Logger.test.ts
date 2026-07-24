/**
 * Unit tests for Logger.
 * Tests redact() strips sensitive values (msy_... keys, Bearer tokens),
 * and setLevel/setEnabled gate log output correctly.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Logger, redact } from "./Logger.js";
import { LogLevel } from "./types.js";

// Capture stderr output for testing
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const originalStderr = process.stderr.write;

  process.stderr.write = ((chunk: any) => {
    lines.push(chunk.toString());
    return true;
  }) as any;

  try {
    fn();
  } finally {
    process.stderr.write = originalStderr;
  }

  return lines;
}

test("redact: strips msy_ prefixed API keys", () => {
  const input = "Using API key msy_abcd1234_test for authentication";
  const output = redact(input);
  assert(!output.includes("msy_abcd1234_test"));
  assert(output.includes("msy_***REDACTED***"));
});

test("redact: strips multiple msy_ keys in one string", () => {
  const input = "Keys: msy_first_key and msy_second_key";
  const output = redact(input);
  assert(output.includes("msy_***REDACTED***"));
  assert(!output.includes("msy_first_key"));
  assert(!output.includes("msy_second_key"));
});

test("redact: strips Bearer tokens", () => {
  const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9";
  const output = redact(input);
  assert(!output.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert(output.includes("Bearer ***REDACTED***"));
});

test("redact: strips Bearer tokens case-insensitively", () => {
  const input = "Auth: bearer abcd1234_token_xyz";
  const output = redact(input);
  assert(!output.includes("abcd1234_token_xyz"));
  // redact()'s regex matches "bearer" case-insensitively (so a lowercase input token
  // is still caught and never leaks) but always substitutes the literal capitalized
  // "Bearer ***REDACTED***" marker rather than preserving the input's original casing
  // — that's an intentional simplification (the token is gone either way), so this
  // assertion checks case-insensitively rather than requiring lowercase output.
  assert(output.toLowerCase().includes("bearer ***redacted***"));
});

test("redact: handles multiple Bearer tokens", () => {
  const input = "Bearer token1 and Bearer token2";
  const output = redact(input);
  assert(!output.includes("token1"));
  assert(!output.includes("token2"));
  assert.equal((output.match(/Bearer \*\*\*REDACTED\*\*\*/g) || []).length, 2);
});

test("redact: does not redact non-API strings", () => {
  const input = "This is a normal message with no secrets";
  const output = redact(input);
  assert.equal(output, input);
});

test("Logger: debug() writes at DEBUG level", () => {
  const logger = new Logger(LogLevel.DEBUG, true);
  const lines = captureStderr(() => {
    logger.debug("Debug message");
  });

  assert(lines.length > 0);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "DEBUG");
  assert(entry.message.includes("Debug message"));
});

test("Logger: info() writes at INFO level", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.info("Info message");
  });

  assert(lines.length > 0);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "INFO");
  assert(entry.message.includes("Info message"));
});

test("Logger: warn() writes at WARN level", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.warn("Warning message");
  });

  assert(lines.length > 0);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "WARN");
  assert(entry.message.includes("Warning message"));
});

test("Logger: error() writes at ERROR level", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.error("Error message");
  });

  assert(lines.length > 0);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "ERROR");
  assert(entry.message.includes("Error message"));
});

test("Logger: setLevel filters by log level", () => {
  const logger = new Logger(LogLevel.WARN, true); // Only WARN and ERROR
  const lines = captureStderr(() => {
    logger.debug("Debug");
    logger.info("Info");
    logger.warn("Warning");
    logger.error("Error");
  });

  assert.equal(lines.length, 2); // Only WARN and ERROR
});

test("Logger: setEnabled gates all output", () => {
  const logger = new Logger(LogLevel.DEBUG, true);
  const lines1 = captureStderr(() => {
    logger.debug("Message 1");
  });

  logger.setEnabled(false);
  const lines2 = captureStderr(() => {
    logger.debug("Message 2");
    logger.info("Message 3");
  });

  logger.setEnabled(true);
  const lines3 = captureStderr(() => {
    logger.debug("Message 4");
  });

  assert.equal(lines1.length, 1);
  assert.equal(lines2.length, 0); // disabled
  assert.equal(lines3.length, 1); // re-enabled
});

test("Logger: redacts message content", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.info("API key is msy_secret_key_12345");
  });

  const entry = JSON.parse(lines[0]);
  assert(entry.message.includes("msy_***REDACTED***"));
  assert(!entry.message.includes("msy_secret_key_12345"));
});

test("Logger: redacts context values", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.info("Request sent", {
      apiKey: "msy_secret_12345",
      token: "Bearer abc123xyz",
      jobId: "job-123", // not redacted
    });
  });

  const entry = JSON.parse(lines[0]);
  assert(entry.context.apiKey.includes("msy_***REDACTED***"));
  assert(entry.context.token.includes("Bearer ***REDACTED***"));
  assert.equal(entry.context.jobId, "job-123");
});

test("Logger: includes timestamp in output", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.info("Timestamped message");
  });

  const entry = JSON.parse(lines[0]);
  assert(entry.timestamp);
  // Verify it's a valid ISO string
  assert(!isNaN(Date.parse(entry.timestamp)));
});

test("Logger: includes context in output when provided", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.info("Message with context", { jobId: "test-123", retries: 3 });
  });

  const entry = JSON.parse(lines[0]);
  assert(entry.context);
  assert.equal(entry.context.jobId, "test-123");
  assert.equal(entry.context.retries, 3);
});

test("Logger: omits context when not provided", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.info("Message without context");
  });

  const entry = JSON.parse(lines[0]);
  assert(!entry.context);
});

test("Logger: logRequest() for successful request", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.logRequest({
      method: "POST",
      path: "/api/generate",
      statusCode: 201,
      durationMs: 1250,
      jobId: "job-123",
    });
  });

  assert(lines.length > 0);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "INFO");
  assert(entry.message.includes("POST /api/generate"));
});

test("Logger: logRequest() for error response is WARN", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.logRequest({
      method: "GET",
      path: "/api/status/123",
      statusCode: 404,
      durationMs: 150,
    });
  });

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "WARN");
});

test("Logger: logRequest() with error message is WARN", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.logRequest({
      method: "DELETE",
      path: "/api/job/123",
      statusCode: 200,
      durationMs: 100,
      error: "Timeout during cleanup",
    });
  });

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "WARN");
});

test("Logger: logRetry() formats retry message", () => {
  const logger = new Logger(LogLevel.INFO, true);
  const lines = captureStderr(() => {
    logger.logRetry({
      attempt: 2,
      maxRetries: 3,
      delayMs: 2000,
      reason: "Service unavailable",
      jobId: "job-123",
    });
  });

  assert(lines.length > 0);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "WARN");
  assert(entry.message.includes("Retry attempt 2/3"));
  assert(entry.message.includes("2000ms"));
});

test("Logger: level transitions work correctly", () => {
  const logger = new Logger(LogLevel.INFO, true);

  // Verify DEBUG is filtered out at INFO level
  let lines = captureStderr(() => {
    logger.debug("Debug 1");
  });
  assert.equal(lines.length, 0);

  // Change to DEBUG level
  logger.setLevel(LogLevel.DEBUG);
  lines = captureStderr(() => {
    logger.debug("Debug 2");
  });
  assert.equal(lines.length, 1);

  // Change back to INFO
  logger.setLevel(LogLevel.INFO);
  lines = captureStderr(() => {
    logger.debug("Debug 3");
  });
  assert.equal(lines.length, 0);
});

test("Logger: disabled logger outputs nothing", () => {
  const logger = new Logger(LogLevel.DEBUG, false);
  const lines = captureStderr(() => {
    logger.debug("Debug");
    logger.info("Info");
    logger.warn("Warn");
    logger.error("Error");
  });

  assert.equal(lines.length, 0);
});
