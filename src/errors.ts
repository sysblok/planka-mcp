/**
 * Typed error classes for PLANKA API operations.
 */

export class PlankaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "PlankaError";
  }
}

export class PlankaAuthError extends PlankaError {
  constructor(message = "Authentication failed") {
    super(message, "AUTH_FAILED", 401);
    this.name = "PlankaAuthError";
  }
}

export class PlankaNotFoundError extends PlankaError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
    this.name = "PlankaNotFoundError";
  }
}

export class PlankaValidationError extends PlankaError {
  constructor(message: string, details?: unknown) {
    super(message, "VALIDATION_ERROR", 422, details);
    this.name = "PlankaValidationError";
  }
}

export class PlankaPermissionError extends PlankaError {
  constructor(message = "Insufficient permissions") {
    super(message, "PERMISSION_DENIED", 403);
    this.name = "PlankaPermissionError";
  }
}

export class PlankaConfigError extends PlankaError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", 0);
    this.name = "PlankaConfigError";
  }
}

export class PlankaNetworkError extends PlankaError {
  constructor(message: string, details?: unknown) {
    super(message, "NETWORK_ERROR", 0, details);
    this.name = "PlankaNetworkError";
  }
}

/**
 * Factory function to create typed errors from API responses.
 * @param status HTTP status code
 * @param body Response body (parsed JSON or null)
 * @param context Optional context (e.g., "GET /api/cards/123")
 */
export function createPlankaError(
  status: number,
  body: unknown,
  context?: string
): PlankaError {
  const message =
    typeof body === "object" && body !== null && "message" in body
      ? String((body as Record<string, unknown>).message)
      : "Unknown error";

  const contextSuffix = context ? ` (${context})` : "";

  switch (status) {
    case 401:
      return new PlankaAuthError(message + contextSuffix);
    case 403:
      return new PlankaPermissionError(message + contextSuffix);
    case 404:
      return new PlankaNotFoundError("Resource", context || "unknown");
    case 422:
      return new PlankaValidationError(message + contextSuffix, body);
    default:
      return new PlankaError(message + contextSuffix, "API_ERROR", status, body);
  }
}

/**
 * Type guard for PlankaError instances.
 */
export function isPlankaError(error: unknown): error is PlankaError {
  return error instanceof PlankaError;
}
