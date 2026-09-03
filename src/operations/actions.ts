/**
 * Planka's activity log ("actions").
 *
 * Planka 2.x records only six kinds of event
 * (`Action.Types` — server/api/models/Action.js:70-77):
 *
 *   createCard · moveCard · addMemberToCard · removeMemberFromCard
 *   completeTask · uncompleteTask
 *
 * There is NO action for a comment, a rename or a description edit. A card
 * whose history looks empty was not necessarily untouched — it was only never
 * moved, assigned or checked off. Every consumer of this module has to say so
 * rather than let a reader infer "nothing happened".
 *
 * Both endpoints (`/api/cards/:id/actions`, `/api/boards/:id/actions`) return
 * at most 50 items — a module constant in Planka, not a query parameter — and
 * page backwards with `?beforeId=<id>` (exclusive, ids descend with time).
 *
 * The raw item is ~350 chars of nested JSON. What a model needs from it is one
 * line: who, when, what. So nothing here returns the raw action.
 */
import { z } from "zod";
import { plankaClient } from "../client.js";
import { withBoardId } from "./board-id.js";

/** Page size Planka hardcodes for actions. */
export const ACTIONS_PAGE_SIZE = 50;

/** The six event types Planka can record. */
export const ACTION_TYPES = [
  "createCard",
  "moveCard",
  "addMemberToCard",
  "removeMemberFromCard",
  "completeTask",
  "uncompleteTask",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const NamedRef = z
  .object({ id: z.string().optional(), name: z.string().nullable().optional() })
  .passthrough();

/**
 * `data` shape verified live against Planka 2.2.1 on 2026-09-03:
 *   createCard            {card:{name}, list:{id,name,type}}
 *   moveCard              {card:{name}, fromList:{id,name,type}, toList:{…}}
 *   add/removeMemberToCard{card:{name}, user:{id,name}}
 *   complete/uncompleteTask {card:{name}, task:{id,name}}
 */
export const ActionSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    createdAt: z.string(),
    boardId: z.string().optional(),
    cardId: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    data: z
      .object({
        card: NamedRef.optional(),
        list: NamedRef.optional(),
        fromList: NamedRef.optional(),
        toList: NamedRef.optional(),
        user: NamedRef.optional(),
        task: NamedRef.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type PlankaAction = z.infer<typeof ActionSchema>;

const ActionsResponse = z.object({
  items: z.array(ActionSchema),
  included: z
    .object({
      users: z
        .array(z.object({ id: z.string(), name: z.string().optional() }).passthrough())
        .optional(),
    })
    .passthrough()
    .optional(),
});

export interface ActionsPage {
  actions: PlankaAction[];
  /** userId -> display name, from the response's own `included.users`. */
  userNames: Map<string, string>;
  /** A full page means Planka had at least this many; there may be more. */
  full: boolean;
}

function toPage(response: unknown): ActionsPage {
  const parsed = ActionsResponse.parse(response);
  const userNames = new Map<string, string>();
  for (const user of parsed.included?.users ?? []) {
    if (user.name) userNames.set(user.id, user.name);
  }
  return {
    actions: parsed.items,
    userNames,
    full: parsed.items.length >= ACTIONS_PAGE_SIZE,
  };
}

/** One page of a card's history, newest first. */
export async function getCardActions(input: {
  cardId: string;
  beforeId?: string;
}): Promise<ActionsPage> {
  const query = input.beforeId ? `?beforeId=${encodeURIComponent(input.beforeId)}` : "";
  return toPage(
    await plankaClient.get<unknown>(`/api/cards/${input.cardId}/actions${query}`)
  );
}

/** One page of a board's history, newest first. */
export async function getBoardActions(input: {
  boardId?: string;
  beforeId?: string;
}): Promise<ActionsPage & { boardId: string }> {
  return withBoardId(input.boardId, async (boardId) => {
    const query = input.beforeId
      ? `?beforeId=${encodeURIComponent(input.beforeId)}`
      : "";
    const page = toPage(
      await plankaClient.get<unknown>(`/api/boards/${boardId}/actions${query}`)
    );
    return { ...page, boardId };
  });
}

/** One event, reduced to what a reader actually reads. */
export interface ActionDigest {
  id: string;
  type: string;
  /** ISO timestamp of the event. */
  at: string;
  /** Display name of whoever did it, or the raw id when unknown. */
  user: string;
  /** Human sentence: "moved from X to Y", "completed task T". */
  summary: string;
  cardId?: string;
}

function label(ref: { name?: string | null } | undefined, fallback: string): string {
  const name = ref?.name;
  return name ? `"${name}"` : fallback;
}

/**
 * The one-line sentence for an action.
 *
 * Everything it needs travels inside `data` — Planka embeds the list, user and
 * task NAMES in the action itself, so no extra lookup is ever made here.
 */
export function summarizeAction(action: PlankaAction): string {
  const data = action.data ?? {};
  switch (action.type) {
    case "createCard":
      return `created the card in ${label(data.list, "a list")}`;
    case "moveCard":
      return `moved the card from ${label(data.fromList, "another list")} to ${label(
        data.toList,
        "another list"
      )}`;
    case "addMemberToCard":
      return `added member ${label(data.user, "someone")}`;
    case "removeMemberFromCard":
      return `removed member ${label(data.user, "someone")}`;
    case "completeTask":
      return `completed task ${label(data.task, "a task")}`;
    case "uncompleteTask":
      return `reopened task ${label(data.task, "a task")}`;
    default:
      // A type Planka added after this was written: say what it is instead of
      // dropping the event.
      return `${action.type} (unrecognised event type)`;
  }
}

/** Turns raw actions into digests, resolving user names where possible. */
export function digestActions(
  actions: PlankaAction[],
  userNames: Map<string, string>,
  options: { withCardId?: boolean } = {}
): ActionDigest[] {
  return actions.map((action) => ({
    id: action.id,
    type: action.type,
    at: action.createdAt,
    user:
      (action.userId ? userNames.get(action.userId) : undefined) ??
      action.userId ??
      "unknown",
    summary: summarizeAction(action),
    ...(options.withCardId && action.cardId ? { cardId: action.cardId } : {}),
  }));
}

/** The card name Planka embeds in every action of that card. */
export function cardNameOf(action: PlankaAction): string | undefined {
  return action.data?.card?.name ?? undefined;
}
