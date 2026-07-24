/**
 * Ambient type declarations for optional dependencies that don't ship (or aren't
 * guaranteed to have) their own TypeScript types, so dynamic `import()` calls in
 * DownloadManager.ts / jobStore.ts still type-check even when these packages are
 * intentionally optional (they're only needed for Draco compression / SQLite
 * persistence — both features degrade gracefully at runtime if absent, per
 * MEMORY.md §7 and PLAN.md §2 item 10).
 *
 * `better-sqlite3`, `archiver`, and `@gltf-transform/*` ship their own types and
 * should NOT be re-declared here (a duplicate ambient declaration for an already-typed
 * module can conflict) — install `@types/better-sqlite3` and `@types/archiver` as
 * devDependencies instead (already in package.json).
 */

declare module "draco3d" {
  export function createEncoderModule(): Promise<unknown>;
  export function createDecoderModule(): Promise<unknown>;
}
