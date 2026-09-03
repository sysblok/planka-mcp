/**
 * Activity tools: what happened to a card, and what happened on a board.
 */
import {
  ACTION_TYPES,
  ActionDigest,
  PlankaAction,
  cardNameOf,
  digestActions,
  getBoardActions,
  getCardActions,
} from "../operations/actions.js";
import { PlankaError } from "../errors.js";

/**
 * The blind spot every consumer has to be told about: Planka logs six event
 * types and none of them is a comment, a rename or a description edit.
 */
const NO_EVENTS_NOTE =
  "Planka only logs card creation, moves, member changes and task completion — " +
  "comments, renames and description edits leave no trace here.";

/** Page ceiling for the board sweep: 5 pages = up to 250 events, ~5 requests. */
const MAX_PAGES = 5;

function errorResult(error: unknown) {
  if (error instanceof PlankaError) {
    return {
      content: [{ type: "text" as const, text: `Error: ${error.message}` }],
      isError: true as const,
    };
  }
  throw error;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

/**
 * Tool: planka_card_history
 */
export const cardHistoryTool = {
  name: "planka_card_history",
  description:
    "One card's activity log as human lines (who, when, what). Planka logs only creation, moves, " +
    "member changes and task completion — never comments or edits. Page back with beforeId.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: { type: "string", description: "The card ID" },
      limit: {
        type: "number",
        description: "How many events to return, newest first. Default 20, max 50.",
      },
      beforeId: {
        type: "string",
        description:
          "Cursor: return only events older than this event id. Use nextBeforeId from a previous call.",
      },
    },
    required: ["cardId"],
  },
  handler: async (params: { cardId: string; limit?: number; beforeId?: string }) => {
    try {
      const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
      const page = await getCardActions({
        cardId: params.cardId,
        beforeId: params.beforeId,
      });

      const selected = page.actions.slice(0, limit);
      const events = digestActions(selected, page.userNames);
      const hasMore = page.actions.length > limit || page.full;
      const last = selected[selected.length - 1];

      return jsonResult({
        cardId: params.cardId,
        ...(page.actions[0] ? { cardName: cardNameOf(page.actions[0]) } : {}),
        returned: events.length,
        events,
        hasMore,
        ...(hasMore && last ? { nextBeforeId: last.id } : {}),
        ...(events.length === 0 ? { note: NO_EVENTS_NOTE } : {}),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
};

/** One card's slice of the board activity. */
interface CardActivity {
  cardId: string;
  cardName?: string;
  events: ActionDigest[];
}

/** Groups events by card, keeping the newest card first. */
function groupByCard(actions: PlankaAction[], digests: ActionDigest[]): CardActivity[] {
  const groups = new Map<string, CardActivity>();

  digests.forEach((digest, index) => {
    const action = actions[index];
    const cardId = action.cardId ?? "unknown";
    let group = groups.get(cardId);
    if (!group) {
      group = { cardId, ...(cardNameOf(action) ? { cardName: cardNameOf(action) } : {}), events: [] };
      groups.set(cardId, group);
    }
    // The cardId travels in the group, not in every event.
    const { cardId: _dropped, ...event } = digest;
    group.events.push(event as ActionDigest);
  });

  return [...groups.values()];
}

/**
 * Tool: planka_board_activity
 */
export const boardActivityTool = {
  name: "planka_board_activity",
  description:
    "What moved on a board, grouped by card — the call to make when resuming a session. " +
    "Walks the activity log back to `since` (ISO date) or up to `limit` events. Planka logs only " +
    "creation, moves, member changes and task completion.",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: { type: "string", description: "Board ID" },
      since: {
        type: "string",
        description:
          "ISO 8601 timestamp. Only events at or after it are returned; the sweep stops there.",
      },
      limit: {
        type: "number",
        description: "Maximum events to return. Default 50, max 250.",
      },
      types: {
        type: "array",
        items: { type: "string", enum: [...ACTION_TYPES] },
        description: "Keep only these event types.",
      },
    },
  },
  handler: async (params: {
    boardId?: string;
    since?: string;
    limit?: number;
    types?: string[];
  }) => {
    try {
      const limit = Math.min(Math.max(params.limit ?? 50, 1), 250);
      const wanted = params.types?.length ? new Set(params.types) : null;

      let sinceMs: number | null = null;
      if (params.since !== undefined) {
        sinceMs = new Date(params.since).getTime();
        if (Number.isNaN(sinceMs)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: since must be an ISO 8601 timestamp (got "${params.since}").`,
              },
            ],
            isError: true as const,
          };
        }
      }

      const kept: PlankaAction[] = [];
      const userNames = new Map<string, string>();
      let beforeId: string | undefined;
      let boardId = params.boardId ?? "";
      let pages = 0;
      let scanned = 0;
      let reachedSince = false;
      let exhausted = false;

      while (pages < MAX_PAGES && kept.length < limit) {
        const page = await getBoardActions({ boardId: params.boardId, beforeId });
        boardId = page.boardId;
        pages++;
        scanned += page.actions.length;
        for (const [id, name] of page.userNames) userNames.set(id, name);

        for (const action of page.actions) {
          if (sinceMs !== null && new Date(action.createdAt).getTime() < sinceMs) {
            reachedSince = true;
            break;
          }
          if (wanted && !wanted.has(action.type)) continue;
          if (kept.length >= limit) break;
          kept.push(action);
        }

        if (reachedSince || !page.full) {
          exhausted = !page.full;
          break;
        }
        beforeId = page.actions[page.actions.length - 1]?.id;
        if (!beforeId) break;
      }

      // Truncated = there is older activity this answer does NOT contain.
      const truncated = !reachedSince && !exhausted;
      const digests = digestActions(kept, userNames, { withCardId: true });
      const cards = groupByCard(kept, digests);

      return jsonResult({
        boardId,
        ...(params.since ? { since: params.since } : {}),
        pagesFetched: pages,
        scanned,
        returned: kept.length,
        cardsTouched: cards.length,
        truncated,
        ...(truncated && kept.length
          ? { nextBeforeId: kept[kept.length - 1].id }
          : {}),
        cards,
        ...(kept.length === 0 ? { note: NO_EVENTS_NOTE } : {}),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const activityTools = [cardHistoryTool, boardActivityTool];
