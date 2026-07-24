/**
 * Maps Meshy's raw status and task types to our normalized JobState enum.
 * Handles the approximation of rich sub-phases (Meshing/Texturing) from Meshy's simpler status.
 *
 * PLAN.md §2 item 5 documents this mapping as an approximation, not a literal Meshy field.
 */

import { JobState } from "../../core/types.js";
import type { MeshyTaskResponse } from "./MeshyClient.js";

/**
 * Inferred task type based on Meshy API response structure.
 * Helps determine whether we're in a Meshing or Texturing phase during IN_PROGRESS.
 */
enum InferredMeshyTaskType {
  TextToPreviewMesh = "text-to-3d-preview",
  TextToRefineTexture = "text-to-3d-refine",
  ImageTo3D = "image-to-3d",
  MultiImageTo3D = "multi-image-to-3d",
  Rigging = "rigging",
  Animation = "animation",
}

/**
 * Infers the task type from a Meshy task response.
 * Looks at response structure to determine if this is a preview, refine, image-based, etc. task.
 * This is a best-effort heuristic since Meshy doesn't explicitly label task type in the status response.
 */
function inferTaskType(response: MeshyTaskResponse): InferredMeshyTaskType {
  // If the response indicates it's a texturing operation (has texture_urls or was created from a preview),
  // we can't know for certain without context, so we use heuristics:
  // - Presence of texture_urls or high progress on a preview (>50%) suggests texturing
  // - No texture_urls suggests mesh generation (preview phase)

  // This is approximate. A production system would track the original request type in the job store
  // or use Meshy's task metadata if it exposes a type field.

  if (response.texture_urls && Object.keys(response.texture_urls).length > 0) {
    return InferredMeshyTaskType.TextToRefineTexture;
  }

  // Default to preview/mesh generation
  return InferredMeshyTaskType.TextToPreviewMesh;
}

/**
 * Determines the processing sub-phase (Meshing vs Texturing) for IN_PROGRESS tasks.
 * Returns 'Meshing' for mesh-generation phases, 'Texturing' for refinement phases.
 * This is documented as an approximation (PLAN.md §2 item 5).
 */
function getProcessingSubPhase(
  response: MeshyTaskResponse,
): "Meshing" | "Texturing" {
  const taskType = inferTaskType(response);

  // If it's a refine/texture operation, return 'Texturing'
  if (taskType === InferredMeshyTaskType.TextToRefineTexture) {
    return "Texturing";
  }

  // For all other operations (preview, image-to-3d, multi-image, etc.), assume mesh generation
  return "Meshing";
}

/**
 * Maps Meshy's raw PENDING/IN_PROGRESS/SUCCEEDED/FAILED/CANCELED status to our JobState enum.
 * Enriches IN_PROGRESS with sub-phase information (Meshing vs Texturing) based on task type.
 *
 * @param status Raw Meshy task status string (from API response)
 * @param response Full Meshy task response (used to infer sub-phase)
 * @returns Normalized JobState
 */
export function meshyStatusToJobState(
  status: string,
  response?: MeshyTaskResponse,
): JobState {
  switch (status) {
    case "PENDING":
      return JobState.Queued;

    case "IN_PROGRESS":
      // If we have response data, try to infer whether we're Meshing or Texturing
      if (response) {
        const subPhase = getProcessingSubPhase(response);
        return subPhase === "Texturing" ? JobState.Texturing : JobState.Meshing;
      }
      // Fallback if no response context provided
      return JobState.Processing;

    case "SUCCEEDED":
      return JobState.Completed;

    case "FAILED":
      return JobState.Failed;

    case "CANCELED":
      return JobState.Cancelled;

    default:
      // Fallback for unknown statuses (should not occur with known Meshy API)
      return JobState.Processing;
  }
}

/**
 * Re-exported for backwards compatibility — the real implementation moved to
 * core/jobStateUtils.ts since it operates only on the provider-agnostic JobState
 * enum and core modules (e.g. JobStatusManager) shouldn't import from a specific
 * provider's folder.
 */
export { getPhaseDescription } from "../../core/jobStateUtils.js";
