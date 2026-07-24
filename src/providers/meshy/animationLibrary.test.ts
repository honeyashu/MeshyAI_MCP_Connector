/**
 * Unit tests for animationLibrary.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  getAnimationAction,
  listAnimationActions,
  getDefaultAnimationAction,
  isValidActionId,
  getHumanoidActions,
} from "./animationLibrary.js";

test("animationLibrary - getAnimationAction returns action by ID", async () => {
  const idle = getAnimationAction("idle");
  assert(idle);
  assert.equal(idle.id, "idle");
  assert.match(idle.name, /Idle/);
});

test("animationLibrary - getAnimationAction returns undefined for unknown ID", async () => {
  const unknown = getAnimationAction("unknown_action_xyz");
  assert.equal(unknown, undefined);
});

test("animationLibrary - listAnimationActions returns all actions", async () => {
  const actions = listAnimationActions();
  assert(Array.isArray(actions));
  assert(actions.length > 0);
  assert(actions.some((a) => a.id === "idle"));
  assert(actions.some((a) => a.id === "walk"));
  assert(actions.some((a) => a.id === "run"));
});

test("animationLibrary - getDefaultAnimationAction returns idle", async () => {
  const defaultAction = getDefaultAnimationAction();
  assert.equal(defaultAction.id, "idle");
});

test("animationLibrary - isValidActionId validates known actions", async () => {
  assert.equal(isValidActionId("idle"), true);
  assert.equal(isValidActionId("walk"), true);
  assert.equal(isValidActionId("run"), true);
  assert.equal(isValidActionId("unknown_action"), false);
});

test("animationLibrary - getHumanoidActions filters humanoid actions", async () => {
  const humanoidActions = getHumanoidActions();
  assert(Array.isArray(humanoidActions));
  assert(humanoidActions.length > 0);
  // All actions in the current library are humanoid
  assert(humanoidActions.every((a) => a.humanoidOnly !== false));
});

test("animationLibrary - all actions have required fields", async () => {
  const actions = listAnimationActions();
  for (const action of actions) {
    assert(action.id);
    assert(action.name);
    assert(action.description);
  }
});
