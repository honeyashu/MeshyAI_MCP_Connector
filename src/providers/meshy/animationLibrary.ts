/**
 * Static reference table of supported animation action IDs for Meshy.
 *
 * Meshy's animation API requires an `action_id` parameter, but the public animation catalog
 * is not exposed as a queryable API endpoint. This table provides known action IDs that callers
 * can use when requesting animations.
 *
 * IMPORTANT: This table must be manually refreshed if Meshy adds new actions.
 * Last updated: 2026-07-23 (based on available Meshy docs; confirm against current API before shipping).
 *
 * See PLAN.md §2 item 8 for context.
 */

/**
 * Animation action metadata.
 */
export interface AnimationAction {
  id: string;
  name: string;
  description: string;
  humanoidOnly?: boolean; // true if this action is only for humanoid/rigged models
}

/**
 * Static animation action library.
 * These action IDs are passed to POST /openapi/v1/animations with a rig_task_id.
 *
 * Note: This table is a best-effort snapshot. For the authoritative list, check Meshy's API docs.
 * If an action_id you're using is rejected by the API, verify it exists in the current Meshy docs
 * and submit an update to this table.
 */
export const animationLibrary: Record<string, AnimationAction> = {
  // Basic idle/standing poses
  idle: {
    id: "idle",
    name: "Idle",
    description: "Standing still, neutral pose",
    humanoidOnly: true,
  },
  idle_a: {
    id: "idle_a",
    name: "Idle A",
    description: "Idle pose variant A",
    humanoidOnly: true,
  },
  idle_b: {
    id: "idle_b",
    name: "Idle B",
    description: "Idle pose variant B",
    humanoidOnly: true,
  },

  // Walking/locomotion
  walk: {
    id: "walk",
    name: "Walk",
    description: "Forward walking cycle",
    humanoidOnly: true,
  },
  walk_fast: {
    id: "walk_fast",
    name: "Walk Fast",
    description: "Fast-paced walking cycle",
    humanoidOnly: true,
  },
  run: {
    id: "run",
    name: "Run",
    description: "Running cycle",
    humanoidOnly: true,
  },

  // Gestures and actions
  wave: {
    id: "wave",
    name: "Wave",
    description: "Waving gesture",
    humanoidOnly: true,
  },
  point: {
    id: "point",
    name: "Point",
    description: "Pointing gesture",
    humanoidOnly: true,
  },
  jump: {
    id: "jump",
    name: "Jump",
    description: "Jumping action",
    humanoidOnly: true,
  },
  dance: {
    id: "dance",
    name: "Dance",
    description: "Dancing motion",
    humanoidOnly: true,
  },
};

/**
 * Gets an animation action by ID.
 * @param actionId The action ID (e.g., 'idle', 'walk')
 * @returns The action metadata, or undefined if not found
 */
export function getAnimationAction(
  actionId: string,
): AnimationAction | undefined {
  return animationLibrary[actionId];
}

/**
 * Lists all available animation actions.
 * @returns Array of animation actions
 */
export function listAnimationActions(): AnimationAction[] {
  return Object.values(animationLibrary);
}

/**
 * Gets the default animation action (used if none is specified).
 * Defaults to 'idle' for a safe, neutral pose.
 */
export function getDefaultAnimationAction(): AnimationAction {
  return (
    animationLibrary["idle"] || {
      id: "idle",
      name: "Idle",
      description: "Standing still, neutral pose",
      humanoidOnly: true,
    }
  );
}

/**
 * Validates that an action ID exists in the library.
 * @param actionId The action ID to validate
 * @returns true if the action exists, false otherwise
 */
export function isValidActionId(actionId: string): boolean {
  return actionId in animationLibrary;
}

/**
 * Gets action IDs suitable for humanoid models.
 * Most actions are humanoid-only, but in the future there might be non-humanoid actions.
 */
export function getHumanoidActions(): AnimationAction[] {
  return Object.values(animationLibrary).filter(
    (action) => action.humanoidOnly !== false,
  );
}
