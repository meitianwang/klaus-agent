import type { ZodError } from "zod/v4";
import { INTERRUPT_MESSAGE_FOR_TOOL_USE } from "./messages.js";

/**
 * Format an error for display in a tool result.
 * Handles AbortError (returns INTERRUPT_MESSAGE_FOR_TOOL_USE), generic errors
 * (message or string conversion), and truncates at 10k chars.
 * Uses duck-typing checks since klaus-agent may not have AbortError/ShellError classes.
 */
export function formatError(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.constructor.name === "AbortError")
  ) {
    return error.message || INTERRUPT_MESSAGE_FOR_TOOL_USE;
  }
  if (!(error instanceof Error)) {
    return String(error);
  }
  const parts = getErrorParts(error);
  const fullMessage =
    parts.filter(Boolean).join("\n").trim() || "Command failed with no output";
  if (fullMessage.length <= 10000) {
    return fullMessage;
  }
  const halfLength = 5000;
  const start = fullMessage.slice(0, halfLength);
  const end = fullMessage.slice(-halfLength);
  return `${start}\n\n... [${fullMessage.length - 10000} characters truncated] ...\n\n${end}`;
}

/**
 * Extract stderr/stdout from ShellError-like objects, or fall back to error.message.
 * Uses duck typing to detect ShellError-like shapes.
 */
export function getErrorParts(error: Error): string[] {
  // Duck-type ShellError: has code, stderr, stdout properties
  if (
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "number" &&
    "stderr" in error
  ) {
    const shellErr = error as Record<string, unknown>;
    return [
      `Exit code ${shellErr.code}`,
      shellErr.interrupted ? INTERRUPT_MESSAGE_FOR_TOOL_USE : "",
      typeof shellErr.stderr === "string" ? shellErr.stderr : "",
      typeof shellErr.stdout === "string" ? shellErr.stdout : "",
    ];
  }
  const parts = [error.message];
  if ("stderr" in error && typeof (error as Record<string, unknown>).stderr === "string") {
    parts.push((error as Record<string, unknown>).stderr as string);
  }
  if ("stdout" in error && typeof (error as Record<string, unknown>).stdout === "string") {
    parts.push((error as Record<string, unknown>).stdout as string);
  }
  return parts;
}

/**
 * Formats a Zod validation path into a readable string
 * e.g., ['todos', 0, 'activeForm'] => 'todos[0].activeForm'
 */
function formatValidationPath(path: PropertyKey[]): string {
  if (path.length === 0) return "";

  return path.reduce((acc, segment, index) => {
    const segmentStr = String(segment);
    if (typeof segment === "number") {
      return `${String(acc)}[${segmentStr}]`;
    }
    return index === 0 ? segmentStr : `${String(acc)}.${segmentStr}`;
  }, "") as string;
}

/**
 * Converts Zod validation errors into a human-readable and LLM friendly error message.
 * Aligned with claude-code's formatZodValidationError.
 */
export function formatZodValidationError(
  toolName: string,
  error: ZodError,
): string {
  const missingParams = error.issues
    .filter(
      (err) =>
        err.code === "invalid_type" &&
        err.message.includes("received undefined"),
    )
    .map((err) => formatValidationPath(err.path));

  const unexpectedParams = error.issues
    .filter((err) => err.code === "unrecognized_keys")
    .flatMap((err) => err.keys);

  const typeMismatchParams = error.issues
    .filter(
      (err) =>
        err.code === "invalid_type" &&
        !err.message.includes("received undefined"),
    )
    .map((err) => {
      const typeErr = err as { expected: string };
      const receivedMatch = err.message.match(/received (\w+)/);
      const received = receivedMatch ? receivedMatch[1] : "unknown";
      return {
        param: formatValidationPath(err.path),
        expected: typeErr.expected,
        received,
      };
    });

  // Default to original error message if we can't create a better one
  let errorContent = error.message;

  // Build a human-readable error message
  const errorParts: string[] = [];

  if (missingParams.length > 0) {
    const missingParamErrors = missingParams.map(
      (param) => `The required parameter \`${param}\` is missing`,
    );
    errorParts.push(...missingParamErrors);
  }

  if (unexpectedParams.length > 0) {
    const unexpectedParamErrors = unexpectedParams.map(
      (param) => `An unexpected parameter \`${param}\` was provided`,
    );
    errorParts.push(...unexpectedParamErrors);
  }

  if (typeMismatchParams.length > 0) {
    const typeErrors = typeMismatchParams.map(
      ({ param, expected, received }) =>
        `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    );
    errorParts.push(...typeErrors);
  }

  if (errorParts.length > 0) {
    errorContent = `${toolName} failed due to the following ${errorParts.length > 1 ? "issues" : "issue"}:\n${errorParts.join("\n")}`;
  }

  return errorContent;
}
