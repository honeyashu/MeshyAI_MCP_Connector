/**
 * Unit tests for EncryptedCredentialStore.
 * Tests encryption/decryption and persistence.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EncryptedCredentialStore } from "./credentialStore.js";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

/**
 * Create a test store pointed at a fresh, isolated temp directory per call —
 * NOT the real `~/.meshy-connector` store. `EncryptedCredentialStore` now accepts
 * an optional `keystoreDir` constructor param specifically so tests don't share
 * on-disk state with each other (or with the user's real credentials); previously
 * every test in this file silently used the same real store, so state saved by
 * one test (e.g. "save and load") leaked into a later test (e.g. "exists returns
 * correct status") depending on run order.
 */
async function createTestStore(): Promise<{
  store: EncryptedCredentialStore;
  keystoreDir: string;
  cleanup: () => Promise<void>;
}> {
  const testKeystoreDir = join(
    tmpdir(),
    `meshy-connector-test-${randomBytes(6).toString("hex")}`,
  );
  const store = new EncryptedCredentialStore(testKeystoreDir);

  const cleanup = async () => {
    try {
      await fs.rm(testKeystoreDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { store, keystoreDir: testKeystoreDir, cleanup };
}

test("EncryptedCredentialStore: save and load", async () => {
  const { store, cleanup } = await createTestStore();

  try {
    const testKey = "msy_test_key_12345";
    await store.save("meshy", testKey);

    const loaded = await store.load("meshy");
    assert.equal(loaded, testKey);
  } finally {
    await cleanup();
  }
});

test("EncryptedCredentialStore: load returns null for missing key", async () => {
  const { store, cleanup } = await createTestStore();

  try {
    const loaded = await store.load("nonexistent");
    assert.equal(loaded, null);
  } finally {
    await cleanup();
  }
});

test("EncryptedCredentialStore: exists returns correct status", async () => {
  const { store, cleanup } = await createTestStore();

  try {
    const existsBefore = await store.exists("meshy");
    assert.equal(existsBefore, false);

    await store.save("meshy", "msy_test_key");

    const existsAfter = await store.exists("meshy");
    assert.equal(existsAfter, true);
  } finally {
    await cleanup();
  }
});

test("EncryptedCredentialStore: delete removes key", async () => {
  const { store, cleanup } = await createTestStore();

  try {
    await store.save("meshy", "msy_test_key");
    assert.equal(await store.exists("meshy"), true);

    await store.delete("meshy");
    assert.equal(await store.exists("meshy"), false);

    const loaded = await store.load("meshy");
    assert.equal(loaded, null);
  } finally {
    await cleanup();
  }
});

test("EncryptedCredentialStore: reject empty credentials", async () => {
  const { store, cleanup } = await createTestStore();

  try {
    try {
      await store.save("meshy", "");
      assert.fail("Should have thrown");
    } catch (error) {
      assert(error instanceof Error);
      assert(error.message.includes("empty credential"));
    }
  } finally {
    await cleanup();
  }
});

test("EncryptedCredentialStore: multiple providers", async () => {
  const { store, cleanup } = await createTestStore();

  try {
    const meshyKey = "msy_key_123";
    const tripoKey = "tripo_key_456";

    await store.save("meshy", meshyKey);
    await store.save("tripo", tripoKey);

    assert.equal(await store.load("meshy"), meshyKey);
    assert.equal(await store.load("tripo"), tripoKey);

    assert.equal(await store.exists("meshy"), true);
    assert.equal(await store.exists("tripo"), true);

    await store.delete("meshy");
    assert.equal(await store.exists("meshy"), false);
    assert.equal(await store.exists("tripo"), true);
  } finally {
    await cleanup();
  }
});

test("EncryptedCredentialStore: persistence across instances", async () => {
  const { store: store1, keystoreDir, cleanup } = await createTestStore();

  try {
    const testKey = "msy_persistent_key";
    await store1.save("meshy", testKey);

    // Create new store instance pointed at the SAME isolated directory
    // (simulates a new app startup reading back what a prior process wrote).
    const store2 = new EncryptedCredentialStore(keystoreDir);
    const loaded = await store2.load("meshy");

    assert.equal(loaded, testKey);
  } finally {
    await cleanup();
  }
});
