/**
 * Unit tests for CredentialManager.
 * Uses mocked HTTP and credential store for full isolation.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { CredentialManager } from "./CredentialManager.js";
import type { CredentialStoreInterface } from "./types.js";
import { ConnectionStatus } from "./types.js";

/**
 * Mock credential store for testing.
 */
class MockCredentialStore implements CredentialStoreInterface {
  private store: Map<string, string> = new Map();

  async save(providerId: string, key: string): Promise<void> {
    this.store.set(providerId, key);
  }

  async load(providerId: string): Promise<string | null> {
    return this.store.get(providerId) ?? null;
  }

  async delete(providerId: string): Promise<void> {
    this.store.delete(providerId);
  }

  async exists(providerId: string): Promise<boolean> {
    return this.store.has(providerId);
  }
}

/**
 * Mock fetch for testing.
 * Allows us to simulate various API responses without hitting the real API.
 */
function createMockFetch(responseConfig: {
  status: number;
  body: Record<string, unknown>;
}) {
  return async (_url: string, _options?: RequestInit) => {
    return new Response(JSON.stringify(responseConfig.body), {
      status: responseConfig.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("CredentialManager: saveCredentials with valid key", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const validKey = "msy_valid_key_12345";
  await manager.saveCredentials("meshy", validKey);

  const loaded = await manager.loadCredentials("meshy");
  assert.equal(loaded, validKey);
});

test("CredentialManager: saveCredentials with invalid key format", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const invalidKey = "invalid_key_no_prefix";

  try {
    await manager.saveCredentials("meshy", invalidKey);
    assert.fail("Should have thrown");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("Invalid API key format"));
  }
});

test("CredentialManager: loadCredentials returns null for missing key", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const result = await manager.loadCredentials("meshy");
  assert.equal(result, null);
});

test("CredentialManager: credentialsExist", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const existsBefore = await manager.credentialsExist("meshy");
  assert.equal(existsBefore, false);

  await manager.saveCredentials("meshy", "msy_test_key");

  const existsAfter = await manager.credentialsExist("meshy");
  assert.equal(existsAfter, true);
});

test("CredentialManager: deleteCredentials", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  await manager.saveCredentials("meshy", "msy_test_key");
  assert.equal(await manager.credentialsExist("meshy"), true);

  await manager.deleteCredentials("meshy");
  assert.equal(await manager.credentialsExist("meshy"), false);
});

test("CredentialManager: testConnection with 200 status", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  // Mock fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    status: 200,
    body: { balance: 100 },
  }) as typeof fetch;

  try {
    const result = await manager.testConnection("meshy", "msy_valid_key");
    assert.equal(result.status, ConnectionStatus.Connected);
    assert.equal(result.balance, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CredentialManager: testConnection with 401 status", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    status: 401,
    body: { message: "Unauthorized" },
  }) as typeof fetch;

  try {
    const result = await manager.testConnection("meshy", "msy_invalid_key");
    assert.equal(result.status, ConnectionStatus.InvalidKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CredentialManager: testConnection with 402 status", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    status: 402,
    body: { message: "Payment required" },
  }) as typeof fetch;

  try {
    const result = await manager.testConnection("meshy", "msy_valid_key");
    assert.equal(result.status, ConnectionStatus.QuotaExceeded);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CredentialManager: testConnection with 429 status", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    status: 429,
    body: { message: "Too many requests" },
  }) as typeof fetch;

  try {
    const result = await manager.testConnection("meshy", "msy_valid_key");
    assert.equal(result.status, ConnectionStatus.RateLimitExceeded);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CredentialManager: testConnection with 500 status", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    status: 500,
    body: { message: "Internal server error" },
  }) as typeof fetch;

  try {
    const result = await manager.testConnection("meshy", "msy_valid_key");
    assert.equal(result.status, ConnectionStatus.UnknownError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CredentialManager: testConnection with no credentials", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const result = await manager.testConnection("meshy");
  assert.equal(result.status, ConnectionStatus.InvalidKey);
});

test("CredentialManager: validateCredentials returns true on success", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);
  // validateCredentials()->testConnection() loads the stored key when no apiKey
  // is passed explicitly, so a credential must actually be saved first — this was
  // missing (the mock store was empty, so testConnection short-circuited to
  // InvalidKey before ever reaching the mocked fetch), causing this test to fail.
  await store.save("meshy", "msy_valid_key_12345");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    status: 200,
    body: { balance: 50 },
  }) as typeof fetch;

  try {
    const isValid = await manager.validateCredentials("meshy");
    assert.equal(isValid, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CredentialManager: validateCredentials returns false on failure", async () => {
  const store = new MockCredentialStore();
  const manager = new CredentialManager(store as CredentialStoreInterface);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    status: 401,
    body: { message: "Unauthorized" },
  }) as typeof fetch;

  try {
    const isValid = await manager.validateCredentials("meshy");
    assert.equal(isValid, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
