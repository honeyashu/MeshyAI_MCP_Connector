/**
 * Encrypted credential file store.
 * Stores API keys using AES-256-GCM encryption.
 * Never logs raw keys. Falls back to local encryption if OS keychain is unavailable.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { CredentialStoreInterface } from "../core/types.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for GCM
const TAG_LENGTH = 16; // GCM auth tag
const DEFAULT_KEYSTORE_DIR = join(homedir(), ".meshy-connector");

/**
 * Loads or generates a master key for encryption in the given keystore directory.
 * On first call, generates a random 256-bit key via crypto.randomBytes and stores it to
 * `<keystoreDir>/.master` with 0600 permissions. Subsequent calls load and return this
 * persisted key.
 */
async function getMasterKey(keystoreDir: string): Promise<Buffer> {
  try {
    await fs.mkdir(keystoreDir, { recursive: true });

    // Try to load existing master key
    try {
      const keyFileContent = await fs.readFile(
        join(keystoreDir, ".master"),
        "utf8",
      );
      return Buffer.from(keyFileContent, "hex");
    } catch {
      // Master key doesn't exist, create a new one
      const masterKey = randomBytes(KEY_LENGTH);
      const keyFilePath = join(keystoreDir, ".master");
      await fs.writeFile(keyFilePath, masterKey.toString("hex"), {
        mode: 0o600,
      });
      return masterKey;
    }
  } catch (error) {
    throw new Error(`Failed to initialize master key: ${error}`);
  }
}

/**
 * Encrypts a value using AES-256-GCM.
 */
function encrypt(masterKey: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Format: IV (hex) + AuthTag (hex) + Ciphertext (hex)
  return `${iv.toString("hex")}${authTag.toString("hex")}${encrypted}`;
}

/**
 * Decrypts a value using AES-256-GCM.
 */
function decrypt(masterKey: Buffer, encryptedData: string): string {
  const ivHex = encryptedData.slice(0, IV_LENGTH * 2);
  const tagHex = encryptedData.slice(
    IV_LENGTH * 2,
    IV_LENGTH * 2 + TAG_LENGTH * 2,
  );
  const ciphertextHex = encryptedData.slice(IV_LENGTH * 2 + TAG_LENGTH * 2);

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString("utf8");
}

/**
 * File-based encrypted credential store.
 * All API keys are encrypted at rest using AES-256-GCM.
 * In-memory cache is NOT used to reduce risk of exposure.
 */
export class EncryptedCredentialStore implements CredentialStoreInterface {
  private masterKeyPromise: Promise<Buffer> | null = null;
  private readonly keystoreDir: string;
  private readonly keystoreFile: string;

  /**
   * @param keystoreDir Directory holding `.master` and `credentials.json`. Defaults to
   * `~/.meshy-connector`. Overridable so tests can point at an isolated temp directory
   * instead of sharing the real, singleton on-disk store (which previously caused
   * cross-test pollution — see credentialStore.test.ts's `createTestStore()`).
   */
  constructor(keystoreDir: string = DEFAULT_KEYSTORE_DIR) {
    this.keystoreDir = keystoreDir;
    this.keystoreFile = join(keystoreDir, "credentials.json");
  }

  private async getMasterKey(): Promise<Buffer> {
    if (!this.masterKeyPromise) {
      this.masterKeyPromise = getMasterKey(this.keystoreDir);
    }
    return this.masterKeyPromise;
  }

  private async readStore(): Promise<Record<string, string>> {
    try {
      const content = await fs.readFile(this.keystoreFile, "utf8");
      return JSON.parse(content);
    } catch (error) {
      // File doesn't exist yet or is corrupted
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {};
      }
      throw error;
    }
  }

  private async writeStore(store: Record<string, string>): Promise<void> {
    await fs.mkdir(this.keystoreDir, { recursive: true });
    await fs.writeFile(this.keystoreFile, JSON.stringify(store, null, 2), {
      mode: 0o600,
    });
  }

  async save(providerId: string, key: string): Promise<void> {
    if (!key || key.trim().length === 0) {
      throw new Error("Cannot save empty credential");
    }

    const masterKey = await this.getMasterKey();
    const store = await this.readStore();

    // Encrypt and store
    store[providerId] = encrypt(masterKey, key);

    await this.writeStore(store);
  }

  async load(providerId: string): Promise<string | null> {
    const store = await this.readStore();
    const encrypted = store[providerId];

    if (!encrypted) {
      return null;
    }

    try {
      const masterKey = await this.getMasterKey();
      return decrypt(masterKey, encrypted);
    } catch (error) {
      throw new Error(
        `Failed to decrypt credential for provider ${providerId}: ${error}`,
      );
    }
  }

  async delete(providerId: string): Promise<void> {
    const store = await this.readStore();
    delete store[providerId];
    await this.writeStore(store);
  }

  async exists(providerId: string): Promise<boolean> {
    const store = await this.readStore();
    return providerId in store;
  }
}

/**
 * Singleton instance of the credential store.
 */
export const credentialStore = new EncryptedCredentialStore();
