/**
 * Deprecated-alias plumbing.
 *
 * The three `planka_manage_*` tools used an `action` enum, which JSON Schema
 * cannot condition `required` on ("boardId is required if action=create").
 * Every one of them therefore grew 20-40 lines of hand-written "which field
 * does this action need?" checks — and that is exactly where the empty-PATCH
 * bugs came from.
 *
 * The tools are now one per action, each with a real `required`. The old names
 * survive as aliases that route `action` to the tool that replaced it, and the
 * presence check they used to do by hand is done here, once, from the target's
 * own schema.
 *
 * The alias also inherits the target's access policy: an alias that reached the
 * handler directly was a way around `PLANKA_DISABLED_TOOLS`
 * (`planka_manage_lists {action:"delete"}` running a disabled
 * `planka_delete_list`), so the policy is consulted on the TARGET's name here.
 */
import { toolBlockedReason } from "../config/policy.js";

/** The slice of a tool this module needs. Avoids importing the registry. */
export interface DispatchTarget {
  name: string;
  inputSchema: { required?: string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (params: any) => Promise<{
    content: Array<{ type: string; [key: string]: unknown }>;
    isError?: boolean;
  }>;
}

/**
 * Required inputSchema fields that never arrived.
 *
 * The inputSchema is JSON Schema, not Zod: this only checks presence, which is
 * what stops a missing `tasks` from blowing up inside the handler as "Cannot
 * read properties of undefined (reading 'map')".
 */
export function missingRequiredArgs(
  schema: { required?: string[] },
  args: unknown
): string[] {
  const required = schema.required ?? [];
  const received =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return required.filter(
    (field) => received[field] === undefined || received[field] === null
  );
}

function toolError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
  };
}

/**
 * Routes a deprecated `action` argument to the tool that replaced it.
 *
 * `optional` lists fields the target declares required but the deployment may
 * fill in (today: boardId, from PLANKA_DEFAULT_BOARD_ID) — the target handler
 * owns that fallback, so the alias must not reject the call first.
 */
export async function dispatchAction(
  aliasName: string,
  params: { action?: string } & Record<string, unknown>,
  targets: Record<string, DispatchTarget>,
  optional: readonly string[] = ["boardId"]
) {
  const action = params.action;
  const target = action ? targets[action] : undefined;
  if (!target) {
    return toolError(
      `Error: unknown action '${action}' for ${aliasName}. Use one of: ${Object.keys(targets).join(", ")}.`
    );
  }

  const missing = missingRequiredArgs(target.inputSchema, params).filter(
    (field) => !optional.includes(field)
  );
  if (missing.length > 0) {
    return toolError(
      `Error: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required for action '${action}'. ` +
        `${aliasName} is deprecated — call ${target.name} instead, which declares this in its schema.`
    );
  }

  // The alias must not be a bypass: the target's own policy decides.
  const blocked = toolBlockedReason(target.name);
  if (blocked) return toolError(blocked);

  return target.handler(params);
}
