/**
 * Unit tests for meshyMapping status conversion.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { meshyStatusToJobState, getPhaseDescription } from "./meshyMapping.js";
import { JobState } from "../../core/types.js";

test("meshyMapping - PENDING maps to Queued", async () => {
  const state = meshyStatusToJobState("PENDING");
  assert.equal(state, JobState.Queued);
});

test("meshyMapping - SUCCEEDED maps to Completed", async () => {
  const state = meshyStatusToJobState("SUCCEEDED");
  assert.equal(state, JobState.Completed);
});

test("meshyMapping - FAILED maps to Failed", async () => {
  const state = meshyStatusToJobState("FAILED");
  assert.equal(state, JobState.Failed);
});

test("meshyMapping - CANCELED maps to Cancelled", async () => {
  const state = meshyStatusToJobState("CANCELED");
  assert.equal(state, JobState.Cancelled);
});

test("meshyMapping - IN_PROGRESS without context maps to Processing", async () => {
  const state = meshyStatusToJobState("IN_PROGRESS");
  assert.equal(state, JobState.Processing);
});

test("meshyMapping - IN_PROGRESS with Meshing task maps to Meshing", async () => {
  const response = {
    id: "task-123",
    status: "IN_PROGRESS",
    progress: 30,
    model_urls: { glb: "https://example.com/model.glb" },
  };
  const state = meshyStatusToJobState("IN_PROGRESS", response as any);
  assert.equal(state, JobState.Meshing);
});

test("meshyMapping - IN_PROGRESS with Texturing task maps to Texturing", async () => {
  const response = {
    id: "task-456",
    status: "IN_PROGRESS",
    progress: 60,
    model_urls: { glb: "https://example.com/model.glb" },
    texture_urls: {
      base_color: "https://example.com/base_color.png",
      normal: "https://example.com/normal.png",
    },
  };
  const state = meshyStatusToJobState("IN_PROGRESS", response as any);
  assert.equal(state, JobState.Texturing);
});

test("meshyMapping - getPhaseDescription returns readable strings", async () => {
  assert.match(getPhaseDescription(JobState.Queued), /Queued/);
  assert.match(getPhaseDescription(JobState.Meshing), /mesh/i);
  assert.match(getPhaseDescription(JobState.Texturing), /texture/i);
  assert.match(getPhaseDescription(JobState.Completed), /Completed/);
  assert.match(getPhaseDescription(JobState.Failed), /Failed/);
  assert.match(getPhaseDescription(JobState.Cancelled), /Cancelled/);
});
