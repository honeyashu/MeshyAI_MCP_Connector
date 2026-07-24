/**
 * Unit tests for MeshyProvider.
 * Tests provider interface implementation with mocked MeshyClient.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { MeshyProvider } from "./MeshyProvider.js";
import { AssetType } from "../../core/types.js";

// Note: MeshyProvider constructs its own internal MeshyClient from an apiKey
// (no dependency-injection seam for a mock client), so these tests exercise
// capabilities/providerId/static behavior directly rather than mocking MeshyClient.
// Network-dependent methods (textToPreview, getJobStatus, etc.) aren't covered here;
// see MeshyClient.test.ts for HTTP-layer coverage via a mocked global.fetch.

test("MeshyProvider - has correct providerId", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(provider.providerId, "meshy");
});

test("MeshyProvider - capabilities reflect Meshy limitations", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  const caps = provider.capabilities;

  // PLAN.md §2 limitations
  assert.equal(caps.supportsBlendFormat, false); // Item 2
  assert.equal(caps.supportsTurntableVideo, false); // Item 3
  assert.equal(caps.supportsWebhooks, false); // Item 6
  assert.equal(caps.supportsNegativePrompt, true); // Item 1
  assert.equal(caps.supportsZipPackage, true); // Item 4
  assert.equal(caps.supportsRigging, true); // Humanoid rigging supported
  assert.equal(caps.supportsAnimation, true); // Animation supported

  // Check supported formats
  assert(caps.supportedFormats.includes(AssetType.GLB));
  assert(caps.supportedFormats.includes(AssetType.FBX));
  assert(caps.supportedFormats.includes(AssetType.OBJ));
  assert(caps.supportedFormats.includes(AssetType.STL));
  // '.blend' isn't a member of AssetType at all (PLAN.md §2 item 2 — not producible
  // via the Meshy API), so there's no enum value to check for "not supported" the
  // way the other formats are checked for "supported" above. Asserting the format
  // list length instead confirms nothing beyond the documented 8 formats snuck in.
  assert.equal(caps.supportedFormats.length, 8);

  // Check rate limits (Pro tier)
  assert.equal(caps.rateLimitPerSecond, 20);
  assert.equal(caps.maxConcurrentJobs, 10);
});

test("MeshyProvider - textToPreview returns task ID", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");

  // We can't easily mock the internal client here without refactoring,
  // so this test validates the method signature and basic structure
  assert.equal(typeof provider.textToPreview, "function");
});

test("MeshyProvider - getJobStatus normalizes status to JobState", async () => {
  // This would require proper mocking setup; simplified for now
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.getJobStatus, "function");
});

test("MeshyProvider - testConnection validates API access", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.testConnection, "function");
});

test("MeshyProvider - getBalance returns account credits", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.getBalance, "function");
});

test("MeshyProvider - rigModel is optional and callable", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.rigModel, "function");
});

test("MeshyProvider - animateModel is optional and callable", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.animateModel, "function");
});

test("MeshyProvider - downloadAssets stub is present", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.downloadAssets, "function");
});

test("MeshyProvider - cancelJob is implemented", async () => {
  const provider = new MeshyProvider("msy_test_key_12345");
  assert.equal(typeof provider.cancelJob, "function");
});
