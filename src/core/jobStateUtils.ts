/**
 * Provider-agnostic helpers for the common JobState enum.
 *
 * Moved out of providers/meshy/meshyMapping.ts (where it originally lived despite
 * operating only on the shared JobState enum, not on anything Meshy-specific) so that
 * core modules like JobStatusManager don't have to import from a specific provider's
 * folder — that would violate the provider-agnostic architecture the whole connector
 * is built around (PLAN.md, IAI3DProvider.ts). meshyMapping.ts re-exports this for
 * backwards compatibility with existing imports/tests.
 */

import { JobState } from "./types.js";

/**
 * Gets a human-readable description of what phase a job is in.
 * Useful for logging and user-facing status messages.
 */
export function getPhaseDescription(jobState: JobState): string {
  switch (jobState) {
    case JobState.Queued:
      return "Queued for processing";
    case JobState.Processing:
      return "Processing";
    case JobState.Meshing:
      return "Generating mesh";
    case JobState.Texturing:
      return "Applying textures";
    case JobState.Completed:
      return "Completed";
    case JobState.Failed:
      return "Failed";
    case JobState.Cancelled:
      return "Cancelled";
    default:
      return "Unknown";
  }
}
