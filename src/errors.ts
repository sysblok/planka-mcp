/**
 * Typed error classes for PLANKA API operations.
 */
import { z } from "zod";

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
  constructor(resource: string, id: string, hint?: string) {
    super(`${resource} not found: ${id}${hint ? ` — ${hint}` : ""}`, "NOT_FOUND", 404);
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
/**
 * Which kind of ID the last path segment of a request is supposed to be.
 * `/api/labels/123` -> labelId. Every Planka ID is a string of digits, so
 * passing the wrong one is invisible until this 404 comes back.
 */
const ID_KIND_BY_COLLECTION: Record<string, string> = {
  cards: "cardId",
  lists: "listId",
  boards: "boardId",
  projects: "projectId",
  labels: "labelId",
  comments: "commentId",
  tasks: "taskId",
  "task-lists": "taskListId",
  attachments: "attachmentId",
  users: "userId",
  "custom-field-groups": "customFieldGroupId",
};

/** The ID kind a context like "PATCH /api/labels/123" was addressing. */
export function idKindFromContext(context?: string): string | undefined {
  if (!context) return undefined;
  const path = context.split(" ").pop() ?? context;
  const match = /\/api\/([a-z-]+)\/([^/?]+)/.exec(path);
  if (!match) return undefined;
  return ID_KIND_BY_COLLECTION[match[1]];
}

/** What a 404 on this request most likely means, in the order to check it. */
function notFoundHint(context?: string): string {
  const kind = idKindFromContext(context);
  const wrongType = kind
    ? `the ID in this path has to be a ${kind}; every Planka ID is a string of digits, so a labelId passed as a listId (or a listId as a cardId) answers exactly this. `
    : "";
  return (
    `${wrongType}Planka also answers 404 where it means 403: if the ID read fine a moment ago, the agent user is probably not a member of that board. ` +
    `Confirm the ID with planka_board_summary or planka_get_structure before assuming the entity is gone.`
  );
}

/**
 * Factory function to create typed errors from API responses.
 *
 * Every branch answers "what should the agent do now?", not just "what broke".
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
      // The client already retried once with a fresh token, so reaching here
      // means the credentials themselves are the problem.
      return new PlankaAuthError(
        `${message}${contextSuffix}. Planka rejected the credentials even after a fresh login — ` +
          "the token is renegotiated automatically, so this is not an expired session. " +
          "Check PLANKA_API_KEY, or PLANKA_AGENT_EMAIL / PLANKA_AGENT_PASSWORD."
      );
    case 403:
      return new PlankaPermissionError(
        `${message}${contextSuffix}. Forbidden: the agent user is probably not a member of this board, ` +
          "or is a viewer where an editor is needed. Planka may also answer 404 for this same cause."
      );
    case 404:
      // The body's own message is worth keeping: Planka distinguishes
      // E_NOT_FOUND from "Card not found" and the like.
      return new PlankaNotFoundError(
        "Resource",
        context || "unknown",
        `${message !== "Unknown error" ? `Planka said "${message}". ` : ""}${notFoundHint(context)}`
      );
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

// ---------------------------------------------------------------------------
// Input validation — errors an agent can act on
// ---------------------------------------------------------------------------

/**
 * An operation's INPUT failed validation.
 *
 * Deliberately NOT a subclass of PlankaError: every tool catches PlankaError
 * to report Planka API failures, and this error has to travel untouched to the
 * dispatcher in `src/index.ts` — the only place that knows the tool name and
 * its inputSchema, and therefore the only place that can build the actionable
 * message.
 */
export class PlankaInputError extends Error {
  constructor(
    public readonly issues: z.ZodIssue[],
    public readonly received: unknown
  ) {
    super(
      `Invalid input: ${issues
        .map((issue) => `${fieldLabel(issue.path)}: ${issue.message}`)
        .join("; ")}`
    );
    this.name = "PlankaInputError";
  }
}

/**
 * Validates an operation's input against its schema.
 * Replaces `Schema.parse(input)`: instead of a bare ZodError it throws a
 * PlankaInputError that keeps what was received, so it can be shown back.
 */
export function parseInput<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown
): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new PlankaInputError(result.error.issues, input);
  }
  return result.data;
}

/** Type guard for Zod validation errors (response-shape failures). */
export function isZodError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}

const MAX_ARGS_PREVIEW = 400;
const MAX_VALUE_PREVIEW = 120;

/** Serializes a value for display inside an error, clipped. */
function preview(value: unknown, max = MAX_ARGS_PREVIEW): string {
  if (value === undefined) return "undefined";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

/** Zod's `path: []` orients nobody; name it explicitly. */
function fieldLabel(path: ReadonlyArray<string | number>): string {
  return path.length > 0 ? path.join(".") : "(whole arguments object)";
}

function valueAtPath(
  root: unknown,
  path: ReadonlyArray<string | number>
): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** What the tool's JSON inputSchema declares for a field, when it declares it. */
function propertyInfo(
  properties: Record<string, unknown> | undefined,
  field: string
): { type: string; description: string } {
  const property = properties?.[field];
  if (!property || typeof property !== "object") {
    return { type: "", description: "" };
  }
  const { type, description } = property as {
    type?: unknown;
    description?: unknown;
  };
  return {
    type: typeof type === "string" ? ` (${type})` : "",
    description:
      typeof description === "string" && description.length > 0
        ? ` — ${description}`
        : "",
  };
}

/**
 * The validation message the model sees: which tool failed, which field, what
 * was expected and what arrived.
 */
export function formatInputError(
  toolName: string,
  error: PlankaInputError,
  schema?: { properties?: Record<string, unknown>; required?: string[] }
): string {
  const lines = error.issues.map((issue) => {
    const label = fieldLabel(issue.path);
    const value = valueAtPath(error.received, issue.path);
    const suffix =
      value === undefined
        ? issue.path.length > 0
          ? " (field missing)"
          : " (nothing received)"
        : ` (received: ${preview(value, MAX_VALUE_PREVIEW)})`;
    const info =
      issue.path.length === 1
        ? propertyInfo(schema?.properties, String(issue.path[0]))
        : { type: "", description: "" };
    return `  - ${label}${info.type}: ${issue.message}${suffix}${info.description}`;
  });

  const out = [`Invalid arguments for ${toolName}:`, ...lines];
  if (schema?.required && schema.required.length > 0) {
    out.push(`Required fields for ${toolName}: ${schema.required.join(", ")}`);
  }
  out.push(`Arguments received: ${preview(error.received)}`);
  return out.join("\n");
}

/**
 * Required fields that never arrived, detected before entering the handler.
 * Without this a missing `tasks` dies as "Cannot read properties of undefined
 * (reading 'map')", which names neither the tool nor the field.
 */
export function formatMissingArgsError(
  toolName: string,
  missing: string[],
  args: unknown,
  schema?: { properties?: Record<string, unknown>; required?: string[] }
): string {
  const out = [
    `Invalid arguments for ${toolName}: missing required field(s): ${missing.join(", ")}.`,
    ...missing.map((field) => {
      const info = propertyInfo(schema?.properties, field);
      return `  - ${field}${info.type}${info.description}`;
    }),
  ];
  if (schema?.required && schema.required.length > 0) {
    out.push(`Required fields for ${toolName}: ${schema.required.join(", ")}`);
  }
  out.push(`Arguments received: ${preview(args)}`);
  return out.join("\n");
}

/**
 * A ZodError that did NOT come from the input: Planka's response did not match
 * the schema. Saying so explicitly keeps the model from assuming it got the
 * arguments wrong.
 */
export function formatResponseShapeError(
  toolName: string,
  error: z.ZodError
): string {
  const lines = error.issues
    .slice(0, 5)
    .map((issue) => `  - ${fieldLabel(issue.path)}: ${issue.message}`);
  const extra =
    error.issues.length > 5 ? [`  … and ${error.issues.length - 5} more`] : [];
  return [
    `PLANKA returned an unexpected response shape while running ${toolName}. ` +
      `This is an API/server mismatch, not a problem with the arguments:`,
    ...lines,
    ...extra,
  ].join("\n");
}
