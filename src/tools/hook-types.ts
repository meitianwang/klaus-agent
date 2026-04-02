// Hook-related types that don't exist in claude-code's Tool.ts.
// Extracted from tools/types.ts to keep that file aligned with Tool.ts.

import type { TextContent, ImageContent } from "../llm/types.js";
import type { AgentToolResult } from "./types.js";

/**
 * Marker interface for errors whose message is safe to include in telemetry.
 * Aligned with claude-code's TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS.
 */
export interface TelemetrySafeError extends Error {
  readonly telemetryMessage: string;
}

/**
 * Result from a PermissionRequest hook.
 * Aligned with claude-code's types/hooks.ts PermissionRequestResult.
 */
export type PermissionRequestResult =
  | {
      type: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: import("./types.js").PermissionUpdate[];
    }
  | {
      type: "deny";
      message?: string;
      interrupt?: boolean;
    };

export interface BeforeToolCallContext {
  toolName: string;
  toolUseId: string;
  args: unknown;
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface AfterToolCallContext {
  toolName: string;
  toolUseId: string;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
}

export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  isError?: boolean;
  /**
   * When true, the tool execution should not continue to the next tool.
   * Aligned with claude-code's shouldPreventContinuation from PostToolUse hooks.
   */
  shouldPreventContinuation?: boolean;
}

/**
 * Context passed to PostToolUseFailure hooks.
 * Aligned with claude-code's PostToolUseFailure hook execution.
 */
export interface PostToolUseFailureContext {
  toolName: string;
  toolUseId: string;
  args: unknown;
  error: Error;
}

/**
 * Result from PostToolUseFailure hooks.
 */
export interface PostToolUseFailureResult {
  content?: (TextContent | ImageContent)[];
  isError?: boolean;
}
