/**
 * Typed HTTP client for the Meshy AI API.
 * Covers all endpoints documented in the API reference (§1 of PLAN.md).
 * Handles authentication, error mapping, and response parsing.
 */

import type { ProviderError } from "../../core/types.js";
import { logger } from "../../core/Logger.js";

const MESHY_BASE_URL = "https://api.meshy.ai";

/**
 * Raw Meshy task status enum (from API).
 */
export enum MeshyTaskStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  SUCCEEDED = "SUCCEEDED",
  FAILED = "FAILED",
  CANCELED = "CANCELED",
}

/**
 * Meshy text-to-3D request body (preview mode).
 */
export interface MeshyTextTo3DPreviewRequest {
  mode: "preview";
  prompt: string;
  negative_prompt?: string;
  model_type?: string;
  ai_model?: string;
  should_remesh?: boolean;
  topology?: string;
  target_polycount?: number;
  decimation_mode?: string;
  pose_mode?: string;
  target_formats?: string[];
  auto_size?: boolean;
  origin_at?: string;
  moderation?: boolean;
  alpha_thumbnail?: boolean;
}

/**
 * Meshy text-to-3D request body (refine mode).
 */
export interface MeshyTextTo3DRefineRequest {
  mode: "refine";
  preview_task_id: string;
  enable_pbr?: boolean;
  hd_texture?: boolean;
  texture_prompt?: string;
  texture_image_url?: string;
  remove_lighting?: boolean;
  target_formats?: string[];
  auto_size?: boolean;
  origin_at?: string;
}

/**
 * Meshy image-to-3D request body.
 */
export interface MeshyImageTo3DRequest {
  image_url?: string;
  input_task_id?: string;
  model_type?: string;
  should_texture?: boolean;
  enable_pbr?: boolean;
  hd_texture?: boolean;
  texture_prompt?: string;
  texture_image_url?: string;
  target_polycount?: number;
  target_formats?: string[];
  multi_view_thumbnails?: boolean;
  auto_size?: boolean;
  origin_at?: string;
  should_remesh?: boolean;
  topology?: string;
  decimation_mode?: string;
  save_pre_remeshed_model?: boolean;
  pose_mode?: string;
  image_enhancement?: boolean;
  remove_lighting?: boolean;
  moderation?: boolean;
  alpha_thumbnail?: boolean;
}

/**
 * Meshy multi-image-to-3D request body.
 */
export interface MeshyMultiImageTo3DRequest {
  image_urls: string[];
  model_type?: string;
  should_texture?: boolean;
  enable_pbr?: boolean;
  hd_texture?: boolean;
  texture_prompt?: string;
  texture_image_url?: string;
  target_polycount?: number;
  target_formats?: string[];
  multi_view_thumbnails?: boolean;
  auto_size?: boolean;
  origin_at?: string;
  should_remesh?: boolean;
  topology?: string;
  decimation_mode?: string;
  save_pre_remeshed_model?: boolean;
  pose_mode?: string;
  image_enhancement?: boolean;
  remove_lighting?: boolean;
  moderation?: boolean;
  alpha_thumbnail?: boolean;
}

/**
 * Meshy rigging request body.
 */
export interface MeshyRiggingRequest {
  input_task_id?: string;
  model_url?: string;
  height_meters?: number;
}

/**
 * Meshy animation request body.
 */
export interface MeshyAnimationRequest {
  rig_task_id: string;
  action_id: string;
  post_process?: {
    change_fps?: number;
    fbx2usdz?: boolean;
    extract_armature?: boolean;
  };
}

/**
 * Raw Meshy task response (status, model URLs, etc.).
 */
export interface MeshyTaskResponse {
  id: string;
  status: string; // Raw string from API (PENDING, IN_PROGRESS, SUCCEEDED, FAILED, CANCELED)
  progress: number;
  model_urls?: Record<string, string>;
  texture_urls?: Record<string, string>;
  thumbnail_url?: string;
  thumbnail_urls?: Record<string, string>;
  alpha_thumbnail_url?: string;
  task_error?: {
    type: string;
    message: string;
    code?: string;
    doc_url?: string;
  };
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  expires_at?: string;
  consumed_credits?: number;
  [key: string]: unknown; // Allow additional fields from Meshy
}

/**
 * Meshy balance response.
 */
export interface MeshyBalanceResponse {
  balance: number;
}

/**
 * Meshy list tasks response.
 */
export interface MeshyListTasksResponse {
  data: MeshyTaskResponse[];
  total: number;
}

/**
 * Typed HTTP client for Meshy API.
 */
export class MeshyClient {
  private apiKey: string;
  private timeout: number;

  constructor(apiKey: string, timeoutMs = 30000) {
    this.apiKey = apiKey;
    this.timeout = timeoutMs;
  }

  /**
   * Builds fetch request headers with auth and content type.
   */
  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Handles HTTP response and error mapping.
   * Throws ProviderError for non-2xx responses.
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get("content-type");
    let body: unknown = null;

    if (contentType?.includes("application/json")) {
      try {
        body = await response.json();
      } catch {
        body = {};
      }
    } else {
      await response.text();
    }

    if (!response.ok) {
      const error: ProviderError = {
        httpStatus: response.status,
        message:
          ((body as Record<string, unknown>)?.message as string) ||
          `HTTP ${response.status}`,
      };

      // Parse Meshy-specific task error if present
      if ((body as Record<string, unknown>)?.task_error) {
        error.taskError = (body as Record<string, unknown>).task_error as {
          type:
            | "invalid_input"
            | "timeout"
            | "service_unavailable"
            | "server_error"
            | "moderation_blocked";
          message: string;
          code?: string;
          doc_url?: string;
        };
      }

      throw error;
    }

    return body as T;
  }

  /**
   * Executes an HTTP request with timeout.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${MESHY_BASE_URL}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const result = await this.handleResponse<T>(response);
      logger.logRequest({
        method,
        path,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof Error && error.name === "AbortError") {
        const timeoutError = new Error(
          `Request timeout after ${this.timeout}ms`,
        );
        logger.logRequest({
          method,
          path,
          durationMs,
          error: timeoutError.message,
        });
        throw timeoutError;
      }
      logger.logRequest({
        method,
        path,
        durationMs,
        statusCode: (error as ProviderError)?.httpStatus,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * POST /openapi/v2/text-to-3d (preview or refine mode).
   */
  async textTo3D(
    request: MeshyTextTo3DPreviewRequest | MeshyTextTo3DRefineRequest,
  ): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "POST",
      "/openapi/v2/text-to-3d",
      request,
    );
  }

  /**
   * POST /openapi/v1/image-to-3d.
   */
  async imageTo3D(request: MeshyImageTo3DRequest): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "POST",
      "/openapi/v1/image-to-3d",
      request,
    );
  }

  /**
   * POST /openapi/v1/multi-image-to-3d.
   */
  async multiImageTo3D(
    request: MeshyMultiImageTo3DRequest,
  ): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "POST",
      "/openapi/v1/multi-image-to-3d",
      request,
    );
  }

  /**
   * POST /openapi/v1/rigging.
   */
  async rig(request: MeshyRiggingRequest): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "POST",
      "/openapi/v1/rigging",
      request,
    );
  }

  /**
   * POST /openapi/v1/animations.
   */
  async animate(request: MeshyAnimationRequest): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "POST",
      "/openapi/v1/animations",
      request,
    );
  }

  /**
   * GET /openapi/v2/text-to-3d/:id.
   */
  async getTextTo3DTask(taskId: string): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "GET",
      `/openapi/v2/text-to-3d/${taskId}`,
    );
  }

  /**
   * GET /openapi/v1/image-to-3d/:id.
   */
  async getImageTo3DTask(taskId: string): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "GET",
      `/openapi/v1/image-to-3d/${taskId}`,
    );
  }

  /**
   * GET /openapi/v1/multi-image-to-3d/:id.
   */
  async getMultiImageTo3DTask(taskId: string): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "GET",
      `/openapi/v1/multi-image-to-3d/${taskId}`,
    );
  }

  /**
   * GET /openapi/v1/rigging/:id.
   */
  async getRiggingTask(taskId: string): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "GET",
      `/openapi/v1/rigging/${taskId}`,
    );
  }

  /**
   * GET /openapi/v1/animations/:id.
   */
  async getAnimationTask(taskId: string): Promise<MeshyTaskResponse> {
    return this.request<MeshyTaskResponse>(
      "GET",
      `/openapi/v1/animations/${taskId}`,
    );
  }

  /**
   * DELETE /openapi/v2/text-to-3d/:id.
   */
  async deleteTextTo3DTask(taskId: string): Promise<void> {
    await this.request("DELETE", `/openapi/v2/text-to-3d/${taskId}`);
  }

  /**
   * DELETE /openapi/v1/image-to-3d/:id.
   */
  async deleteImageTo3DTask(taskId: string): Promise<void> {
    await this.request("DELETE", `/openapi/v1/image-to-3d/${taskId}`);
  }

  /**
   * DELETE /openapi/v1/multi-image-to-3d/:id.
   */
  async deleteMultiImageTo3DTask(taskId: string): Promise<void> {
    await this.request("DELETE", `/openapi/v1/multi-image-to-3d/${taskId}`);
  }

  /**
   * DELETE /openapi/v1/rigging/:id.
   */
  async deleteRiggingTask(taskId: string): Promise<void> {
    await this.request("DELETE", `/openapi/v1/rigging/${taskId}`);
  }

  /**
   * DELETE /openapi/v1/animations/:id.
   */
  async deleteAnimationTask(taskId: string): Promise<void> {
    await this.request("DELETE", `/openapi/v1/animations/${taskId}`);
  }

  /**
   * GET /openapi/v1/balance.
   */
  async getBalance(): Promise<number> {
    const response = await this.request<MeshyBalanceResponse>(
      "GET",
      "/openapi/v1/balance",
    );
    return response.balance;
  }

  /**
   * Opens a Server-Sent Events (SSE) stream for real-time task status updates.
   * Meshy exposes GET .../:id/stream for every generation task type (text-to-3d,
   * image-to-3d, multi-image-to-3d, rigging, animations). Callers build the path
   * with `buildStreamPath()` below and pass it here; the raw Response is returned
   * so JobStatusManager (Phase 7) can parse the `event:`/`data:` SSE frames from
   * `response.body`, since SSE parsing is a status-tracking concern, not an HTTP
   * transport concern.
   *
   * Throws if the stream can't be opened (non-2xx or no response body).
   */
  async streamTaskStatus(
    streamPath: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${MESHY_BASE_URL}${streamPath}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.buildHeaders(),
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to open SSE stream (${streamPath}): HTTP ${response.status}`,
      );
    }
    if (!response.body) {
      throw new Error(`SSE stream response for ${streamPath} has no body`);
    }

    return response;
  }

  /**
   * Builds the correct `.../stream` path for a given generation mode + task ID.
   * See PLAN.md §1 for the endpoint-per-mode mapping.
   */
  static buildStreamPath(
    mode: MeshyStreamableTaskType,
    taskId: string,
  ): string {
    switch (mode) {
      case "text-to-3d":
        return `/openapi/v2/text-to-3d/${taskId}/stream`;
      case "image-to-3d":
        return `/openapi/v1/image-to-3d/${taskId}/stream`;
      case "multi-image-to-3d":
        return `/openapi/v1/multi-image-to-3d/${taskId}/stream`;
      case "rigging":
        return `/openapi/v1/rigging/${taskId}/stream`;
      case "animation":
        return `/openapi/v1/animations/${taskId}/stream`;
      default: {
        const exhaustiveCheck: never = mode;
        throw new Error(`Unknown streamable task type: ${exhaustiveCheck}`);
      }
    }
  }
}

/**
 * Task types that support SSE streaming, used by buildStreamPath().
 */
export type MeshyStreamableTaskType =
  "text-to-3d" | "image-to-3d" | "multi-image-to-3d" | "rigging" | "animation";
