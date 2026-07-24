/**
 * Structured logger for the connector.
 * Logs request/response timing, job IDs, downloads, errors, warnings, and retry attempts.
 * NEVER logs API secrets — callers must pass already-redacted data.
 *
 * See original spec §12 (Logging) and PLAN.md §3 (module layout).
 */

import { LogLevel } from "./types.js";

/**
 * Structured log entry fields. Extra fields are allowed for context
 * (jobId, taskId, requestId, durationMs, etc.) but must never include
 * raw API keys/secrets — use redact() below for anything credential-shaped.
 */
export interface LogContext {
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

/**
 * Redacts anything that looks like a secret (API key, bearer token) from a string.
 * Used defensively even though callers shouldn't be passing secrets to the logger
 * in the first place.
 */
export function redact(value: string): string {
  return value
    .replace(/msy_[a-zA-Z0-9_-]+/g, "msy_***REDACTED***")
    .replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, "Bearer ***REDACTED***");
}

/**
 * Structured logger. One instance is typically shared across the connector
 * (see the `logger` singleton at the bottom of this file), but callers can
 * instantiate their own with different levels/output for testing.
 */
export class Logger {
  private level: LogLevel;
  private enabled: boolean;

  constructor(level: LogLevel = LogLevel.INFO, enabled = true) {
    this.level = level;
    this.enabled = enabled;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.enabled && LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: redact(message),
      ...(context ? { context: this.redactContext(context) } : {}),
    };

    const line = JSON.stringify(entry);

    // All levels go to stderr, regardless of severity: stdout is reserved exclusively
    // for the MCP stdio transport (server/mcpServer.ts) and must never carry log output,
    // or it would corrupt the JSON-RPC stream the MCP client is reading.
    process.stderr.write(line + "\n");
  }

  /**
   * Redacts secret-shaped values from a context object one level deep.
   * Not a full deep-clone/redact — good enough given callers shouldn't be
   * passing raw credentials into log context in the first place.
   */
  private redactContext(context: LogContext): LogContext {
    const redacted: LogContext = {};
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === "string") {
        redacted[key] = redact(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  debug(message: string, context?: LogContext): void {
    this.write(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write(LogLevel.WARN, message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write(LogLevel.ERROR, message, context);
  }

  /**
   * Convenience helper for logging an HTTP request/response pair with duration.
   * Per spec §12: request time, response time, duration, request ID, job ID.
   */
  logRequest(params: {
    method: string;
    path: string;
    statusCode?: number;
    durationMs: number;
    jobId?: string;
    taskId?: string;
    requestId?: string;
    error?: string;
  }): void {
    const { statusCode, error } = params;
    const level =
      error || (statusCode && statusCode >= 400)
        ? LogLevel.WARN
        : LogLevel.INFO;
    this.write(level, `${params.method} ${params.path}`, params);
  }

  /**
   * Convenience helper for logging a retry attempt.
   */
  logRetry(params: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    reason: string;
    jobId?: string;
    taskId?: string;
  }): void {
    this.warn(
      `Retry attempt ${params.attempt}/${params.maxRetries} after ${Math.round(params.delayMs)}ms: ${params.reason}`,
      params,
    );
  }
}

/**
 * Shared logger singleton. Configure once at startup via configureLogger().
 */
export const logger = new Logger();

/**
 * Configures the shared logger singleton from ConnectorConfig.
 */
export function configureLogger(
  enableLogging: boolean,
  logLevel: LogLevel,
): void {
  logger.setEnabled(enableLogging);
  logger.setLevel(logLevel);
}
