/**
 * Credential management layer.
 * Handles saving, loading, validating, and testing API credentials.
 * Works with encrypted credential store underneath.
 */

import { z } from "zod";
import type {
  CredentialStoreInterface,
  TestConnectionResult,
} from "./types.js";
import { ConnectionStatus } from "./types.js";
import { credentialStore } from "../store/credentialStore.js";

/**
 * Schema for validating Meshy API keys.
 * Meshy keys start with "msy_" prefix.
 */
const MeshyKeySchema = z.string().regex(/^msy_[a-zA-Z0-9_-]+$/);

export class CredentialManager {
  private store: CredentialStoreInterface;

  /**
   * Accepts any `CredentialStoreInterface` implementation (dependency inversion),
   * not just the concrete `EncryptedCredentialStore` — this is what lets tests pass
   * a lightweight mock store instead of exercising real disk/encryption I/O, and
   * keeps the door open for alternative store implementations later.
   */
  constructor(credentialStoreInstance?: CredentialStoreInterface) {
    this.store = credentialStoreInstance || credentialStore;
  }

  /**
   * Validates API key format.
   * Currently only supports Meshy keys (msy_* format).
   */
  private validateKeyFormat(providerId: string, key: string): boolean {
    switch (providerId) {
      case "meshy":
        return MeshyKeySchema.safeParse(key).success;
      default:
        return false;
    }
  }

  /**
   * Saves a credential to the encrypted store.
   * @throws Error if key format is invalid or save fails
   */
  async saveCredentials(providerId: string, apiKey: string): Promise<void> {
    if (!this.validateKeyFormat(providerId, apiKey)) {
      throw new Error(
        `Invalid API key format for provider ${providerId}. Check key prefix/format.`,
      );
    }

    try {
      await this.store.save(providerId, apiKey);
    } catch (error) {
      throw new Error(`Failed to save credentials for ${providerId}: ${error}`);
    }
  }

  /**
   * Loads a credential from the encrypted store.
   * @returns The API key or null if not found.
   * @throws Error if decryption fails.
   */
  async loadCredentials(providerId: string): Promise<string | null> {
    try {
      return await this.store.load(providerId);
    } catch (error) {
      throw new Error(`Failed to load credentials for ${providerId}: ${error}`);
    }
  }

  /**
   * Checks if a credential exists for a provider.
   */
  async credentialsExist(providerId: string): Promise<boolean> {
    try {
      return await this.store.exists(providerId);
    } catch (error) {
      throw new Error(
        `Failed to check credential existence for ${providerId}: ${error}`,
      );
    }
  }

  /**
   * Deletes a credential for a provider.
   */
  async deleteCredentials(providerId: string): Promise<void> {
    try {
      await this.store.delete(providerId);
    } catch (error) {
      throw new Error(
        `Failed to delete credentials for ${providerId}: ${error}`,
      );
    }
  }

  /**
   * Tests connection to a provider by calling its health/balance endpoint.
   * Maps HTTP status codes to ConnectionStatus enum.
   *
   * For Meshy: calls GET /openapi/v1/balance
   * - 200: Connected (with balance)
   * - 401: InvalidKey or Unauthorized
   * - 402: QuotaExceeded
   * - 429: RateLimitExceeded
   * - 5xx: UnknownError / service unavailable
   * - Network error: NetworkError
   */
  async testConnection(
    providerId: string,
    apiKey?: string,
  ): Promise<TestConnectionResult> {
    try {
      const key = apiKey || (await this.loadCredentials(providerId));

      if (!key) {
        return {
          status: ConnectionStatus.InvalidKey,
          message: `No credentials found for ${providerId}`,
        };
      }

      if (!this.validateKeyFormat(providerId, key)) {
        return {
          status: ConnectionStatus.InvalidKey,
          message: `Invalid key format for ${providerId}`,
        };
      }

      // Test provider-specific endpoint
      switch (providerId) {
        case "meshy":
          return await this.testMeshyConnection(key);
        default:
          return {
            status: ConnectionStatus.UnknownError,
            message: `Unknown provider: ${providerId}`,
          };
      }
    } catch (error) {
      // Network or other errors
      return {
        status: ConnectionStatus.NetworkError,
        message: `Connection test failed: ${error}`,
      };
    }
  }

  /**
   * Tests connection to Meshy API.
   * Calls GET https://api.meshy.ai/openapi/v1/balance
   */
  private async testMeshyConnection(
    apiKey: string,
  ): Promise<TestConnectionResult> {
    const url = "https://api.meshy.ai/openapi/v1/balance";
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
      });

      const body = (await response.json()) as Record<string, unknown>;

      switch (response.status) {
        case 200:
          // Success: return balance
          return {
            status: ConnectionStatus.Connected,
            balance: body.balance as number | undefined,
            message: "Connected",
          };

        case 401:
          // Unauthorized: invalid key
          return {
            status: ConnectionStatus.InvalidKey,
            message: "Invalid or expired API key",
          };

        case 402:
          // Payment required: quota exceeded
          return {
            status: ConnectionStatus.QuotaExceeded,
            message: "Account quota exceeded or insufficient credits",
          };

        case 429:
          // Too many requests
          return {
            status: ConnectionStatus.RateLimitExceeded,
            message: "Rate limit exceeded",
          };

        case 500:
        case 502:
        case 503:
        case 504:
          // Server error
          return {
            status: ConnectionStatus.UnknownError,
            message: `Meshy API error: ${response.status} ${response.statusText}`,
          };

        default:
          return {
            status: ConnectionStatus.UnknownError,
            message: `Unexpected response: ${response.status}`,
          };
      }
    } catch (error) {
      // Network error or fetch failure
      if (error instanceof TypeError) {
        return {
          status: ConnectionStatus.NetworkError,
          message: `Network error: ${error.message}`,
        };
      }
      return {
        status: ConnectionStatus.UnknownError,
        message: `Test connection failed: ${error}`,
      };
    }
  }

  /**
   * Validates credentials by testing connection.
   * @returns true if connected, false otherwise.
   */
  async validateCredentials(providerId: string): Promise<boolean> {
    const result = await this.testConnection(providerId);
    return result.status === ConnectionStatus.Connected;
  }
}

/**
 * Singleton instance of the credential manager.
 */
export const credentialManager = new CredentialManager();
