/**
 * Reusable retry/backoff policy.
 * Extracted from GenerationManager's inline implementation (Phase 5) per PLAN.md §3
 * so DownloadManager, JobStatusManager, and GenerationManager all share one implementation.
 *
 * Retry semantics per PLAN.md §6:
 * - timeout / service_unavailable / 5xx / network errors → retry with exponential backoff
 * - invalid_input / moderation_blocked → fail fast, no retry
 */

import { logger } from "./Logger.js";
import type { ProviderError } from "./types.js";

export interface BackoffConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitter?: boolean;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
};

/**
 * Determines if an error is transient and should trigger a retry.
 * Handles both ProviderError objects (thrown by MeshyClient, with httpStatus/taskError)
 * and plain Error/network failures.
 */
export function isTransientError(error: unknown): boolean {
  // ProviderError shape (from MeshyClient.handleResponse)
  if (error && typeof error === "object" && "httpStatus" in error) {
    const providerError = error as ProviderError;

    // 5xx are always transient
    if (providerError.httpStatus >= 500) return true;

    // 429 (rate limit / queue full) is transient — caller should back off and retry
    if (providerError.httpStatus === 429) return true;

    // Task-level error type takes precedence when present
    if (providerError.taskError) {
      return (
        providerError.taskError.type === "timeout" ||
        providerError.taskError.type === "service_unavailable" ||
        providerError.taskError.type === "server_error"
      );
    }

    // 4xx other than 429 (400/401/402/403/404) are not transient — fail fast
    return false;
  }

  // Plain Error / network failure (fetch throws TypeError on network issues,
  // or our own "Request timeout after Xms" Error from MeshyClient)
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("service_unavailable") ||
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      message.includes("network") ||
      error.name === "AbortError" ||
      error.name === "TypeError" // fetch's generic "failed to fetch" / network error
    );
  }

  return false;
}

/**
 * Executes `fn` with exponential backoff retry on transient errors.
 * Non-transient errors (invalid_input, moderation_blocked, 4xx other than 429) fail fast.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  context?: { jobId?: string; taskId?: string; operation?: string },
): Promise<T> {
  const { maxRetries, initialDelayMs, maxDelayMs, jitter = true } = config;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isTransientError(error) || attempt === maxRetries) {
        throw error;
      }

      const delayMs = Math.min(
        initialDelayMs * Math.pow(2, attempt),
        maxDelayMs,
      );
      const finalDelayMs = jitter
        ? delayMs * (0.5 + Math.random() * 0.5)
        : delayMs;

      logger.logRetry({
        attempt: attempt + 1,
        maxRetries,
        delayMs: finalDelayMs,
        reason: error instanceof Error ? error.message : String(error),
        jobId: context?.jobId,
        taskId: context?.taskId,
      });

      await new Promise((resolve) => setTimeout(resolve, finalDelayMs));
    }
  }

  throw lastError ?? new Error("All retries exhausted");
}
