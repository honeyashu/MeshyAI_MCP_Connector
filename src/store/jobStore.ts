/**
 * SQLite-backed persistence for JobMetadata.
 * Implements JobStoreInterface (types.ts) so GenerationManager can optionally persist
 * job state beyond its in-memory Map, surviving process restarts.
 *
 * `better-sqlite3` is an optional dependency (native compile — see MEMORY.md §7 for the
 * sandbox limitation that motivated making it optional). If it isn't installed/available,
 * `createJobStore()` returns `undefined` and GenerationManager falls back to in-memory-only
 * tracking, which is a documented, acceptable degradation (not a silent failure — a warning
 * is logged once).
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import {
  JobState,
  type JobMetadata,
  type JobStoreInterface,
} from "../core/types.js";
import { logger } from "../core/Logger.js";

const DB_DIR = join(homedir(), ".meshy-connector");
const DB_FILE = join(DB_DIR, "jobs.sqlite3");

/**
 * Minimal shape of the better-sqlite3 Database we rely on, so this file can be
 * type-checked without a hard `import` of the optional dependency (which may not
 * be installed). Loaded via dynamic import at runtime instead.
 */
interface BetterSqlite3Database {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  taskId TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  provider TEXT NOT NULL,
  generationMode TEXT NOT NULL,
  prompt TEXT,
  negativePrompt TEXT,
  modelType TEXT,
  targetFormats TEXT NOT NULL,
  meshName TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  state TEXT NOT NULL,
  progress INTEGER NOT NULL,
  errorMessage TEXT,
  errorCode TEXT,
  consumedCredits INTEGER,
  downloadPath TEXT,
  downloadedAssets TEXT NOT NULL,
  rawResponse TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_provider ON jobs(provider);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
`;

/**
 * Serializes a JobMetadata row for SQLite storage (arrays/objects → JSON text).
 */
function toRow(job: JobMetadata): Record<string, unknown> {
  return {
    taskId: job.taskId,
    jobId: job.jobId,
    provider: job.provider,
    generationMode: job.generationMode,
    prompt: job.prompt,
    negativePrompt: job.negativePrompt ?? null,
    modelType: job.modelType ?? null,
    targetFormats: JSON.stringify(job.targetFormats),
    meshName: job.meshName,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    state: job.state,
    progress: job.progress,
    errorMessage: job.errorMessage ?? null,
    errorCode: job.errorCode ?? null,
    consumedCredits: job.consumedCredits ?? null,
    downloadPath: job.downloadPath ?? null,
    downloadedAssets: JSON.stringify(job.downloadedAssets),
    rawResponse: job.rawResponse ? JSON.stringify(job.rawResponse) : null,
  };
}

/**
 * Deserializes a SQLite row back into JobMetadata.
 */
function fromRow(row: Record<string, unknown>): JobMetadata {
  return {
    taskId: row.taskId as string,
    jobId: row.jobId as string,
    provider: row.provider as string,
    generationMode: row.generationMode as JobMetadata["generationMode"],
    prompt: row.prompt as string,
    negativePrompt: (row.negativePrompt as string | null) ?? undefined,
    modelType: (row.modelType as string | null) ?? undefined,
    targetFormats: JSON.parse(row.targetFormats as string),
    meshName: row.meshName as string,
    createdAt: row.createdAt as string,
    startedAt: (row.startedAt as string | null) ?? undefined,
    completedAt: (row.completedAt as string | null) ?? undefined,
    state: row.state as JobState,
    progress: row.progress as number,
    errorMessage: (row.errorMessage as string | null) ?? undefined,
    errorCode: (row.errorCode as string | null) ?? undefined,
    consumedCredits: (row.consumedCredits as number | null) ?? undefined,
    downloadPath: (row.downloadPath as string | null) ?? undefined,
    downloadedAssets: JSON.parse(row.downloadedAssets as string),
    rawResponse: row.rawResponse
      ? JSON.parse(row.rawResponse as string)
      : undefined,
  };
}

/**
 * SQLite-backed implementation of JobStoreInterface.
 */
export class SqliteJobStore implements JobStoreInterface {
  constructor(private db: BetterSqlite3Database) {}

  async save(job: JobMetadata): Promise<void> {
    const row = toRow(job);
    const columns = Object.keys(row);
    const placeholders = columns.map((c) => `@${c}`).join(", ");
    const updates = columns
      .filter((c) => c !== "taskId")
      .map((c) => `${c} = @${c}`)
      .join(", ");

    this.db
      .prepare(
        `INSERT INTO jobs (${columns.join(", ")}) VALUES (${placeholders})
         ON CONFLICT(taskId) DO UPDATE SET ${updates}`,
      )
      .run(row);
  }

  async get(taskId: string): Promise<JobMetadata | undefined> {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE taskId = ?")
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  async list(filter?: {
    provider?: string;
    state?: JobState;
  }): Promise<JobMetadata[]> {
    let sql = "SELECT * FROM jobs";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.provider) {
      conditions.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter?.state) {
      conditions.push("state = ?");
      params.push(filter.state);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY createdAt DESC";

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map(fromRow);
  }

  async delete(taskId: string): Promise<void> {
    this.db.prepare("DELETE FROM jobs WHERE taskId = ?").run(taskId);
  }
}

/**
 * Attempts to create a SqliteJobStore. Returns undefined (rather than throwing) if
 * `better-sqlite3` isn't installed or fails to load — callers should treat that as
 * "no persistence available" and fall back to in-memory-only job tracking.
 */
export async function createJobStore(): Promise<SqliteJobStore | undefined> {
  try {
    mkdirSync(DB_DIR, { recursive: true });

    // Dynamic import: better-sqlite3 is an optionalDependency (native compile).
    // If it's not installed, this throws and we degrade gracefully below.
    const mod = await import("better-sqlite3");
    const DatabaseCtor = mod.default;
    const db = new DatabaseCtor(DB_FILE) as unknown as BetterSqlite3Database;
    db.exec(SCHEMA);

    logger.info("Job store initialized", { path: DB_FILE });
    return new SqliteJobStore(db);
  } catch (error) {
    logger.warn(
      "better-sqlite3 not available — job persistence disabled, falling back to in-memory-only tracking",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return undefined;
  }
}
