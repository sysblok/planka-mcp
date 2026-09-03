/**
 * Scoped query tools — they avoid pulling a whole board when only one column
 * matters.
 *
 * All of them return small JSON and, when they clip, they say so (`total`,
 * `returned`, `hasMore`, `nextOffset`): the model never has to guess whether
 * it saw everything.
 */
import { getBoardSummary, findCards } from "../operations/boards.js";
import { PlankaError } from "../errors.js";

/** Standard JSON response for these tools. */
function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload) },
    ],
  };
}

/**
 * Wraps a handler so PLANKA API failures come back as actionable text.
 * PlankaInputError travels on untouched: `src/index.ts` formats it, being the
 * only layer that knows the tool's inputSchema.
 */
function withPlankaErrors<P>(
  handler: (params: P) => Promise<ReturnType<typeof jsonResult>>
) {
  return async (params: P) => {
    try {
      return await handler(params);
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  };
}

/** Arguments shared by planka_find_cards and its planka_list_cards alias. */
export interface FindCardsParams {
  boardId?: string;
  listId?: string;
  listName?: string;
  query?: string;
  labelName?: string;
  labelFilter?: string;
  labelIds?: string[];
  userIds?: string[];
  withLabels?: boolean;
  detail?: "digest" | "full";
  withDescription?: boolean;
  descriptionChars?: number;
  limit?: number;
  offset?: number;
}

const findCardsProperties = {
  boardId: {
    type: "string",
    description:
      "The board ID. Optional when the server has PLANKA_DEFAULT_BOARD_ID; ignored when listId is given (the list names its own board).",
  },
  listId: {
    type: "string",
    description:
      "Read exactly this column. THE CHEAP PATH: one request, no pagination, so total is the real size of the column and truncated is false by construction.",
  },
  listName: {
    type: "string",
    description:
      "Column name fragment (case- and accent-insensitive) instead of an ID. Costs a board read; listId is cheaper.",
  },
  query: {
    type: "string",
    description:
      "Free text matched against card name AND description. Several words are ANDed — all must appear — ignoring case and accents. A leading '/' makes the rest a case-insensitive regular expression.",
  },
  labelName: {
    type: "string",
    description:
      "Only cards carrying this label name (exact name, case- and accent-insensitive). If the board has no such label, the response says so and lists the ones it does have.",
  },
  labelFilter: {
    type: "string",
    description: "Alias of labelName.",
  },
  labelIds: {
    type: "array",
    items: { type: "string" },
    description: "Only cards carrying at least one of these label IDs (OR).",
  },
  userIds: {
    type: "array",
    items: { type: "string" },
    description:
      "Only cards where one of these users is a member or a task assignee (OR).",
  },
  withLabels: {
    type: "boolean",
    description:
      "Resolve label names. Default true; false skips one board read on the listId path.",
  },
  detail: {
    type: "string",
    enum: ["digest", "full"],
    description:
      "digest (default): id, name, labels, members, tasks, dueDate, commentsTotal, updatedAt. full: every field of the card, description included.",
  },
  withDescription: {
    type: "boolean",
    description:
      "Add a 200-character description preview per match. Default false — this is the expensive field.",
  },
  descriptionChars: {
    type: "number",
    description:
      "Length of that preview. 0 (the default) leaves descriptions out; overrides withDescription.",
  },
  limit: {
    type: "number",
    description: "Max matches to return. Default 25, max 200.",
  },
  offset: {
    type: "number",
    description:
      "Skip this many matches. Use nextOffset from the previous response.",
  },
} as const;

/**
 * Tool: planka_find_cards — the one read over a board's cards.
 */
export const findCardsTool = {
  name: "planka_find_cards",
  description:
    "Cards of a board or of ONE column, filtered by column, text, label or member, returned as digests. " +
    "With listId it reads that column in a single request — unpaginated, so `total` is the whole column and nothing is silently clipped. " +
    "Without it, it filters over one board read (archive and trash excluded). " +
    "At least one filter is required: listId, listName, query, labelName, labelIds or userIds.",
  inputSchema: {
    type: "object" as const,
    properties: findCardsProperties,
  },
  handler: withPlankaErrors(async (params: FindCardsParams) => {
    const result = await findCards(params);
    return jsonResult({
      boardId: result.boardId,
      ...(result.list ? { list: result.list } : {}),
      filters: result.filters,
      ...(result.detail !== "digest" ? { detail: result.detail } : {}),
      source: result.source,
      ...(result.labelsResolved ? {} : { labelsResolved: false }),
      ...(result.truncated === false ? { truncated: false } : {}),
      ...(result.excludesArchived ? { excludesArchived: true } : {}),
      total: result.total,
      returned: result.returned,
      offset: result.offset,
      hasMore: result.hasMore,
      ...(result.nextOffset !== undefined
        ? { nextOffset: result.nextOffset }
        : {}),
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      matches: result.matches,
    });
  }),
};

/**
 * Tool: planka_list_cards — alias of planka_find_cards with listId.
 */
export const listCardsTool = {
  name: "planka_list_cards",
  description:
    "Alias of planka_find_cards with listId: the cards of ONE column, in one request. " +
    "Same arguments and same response; prefer planka_find_cards.",
  inputSchema: {
    type: "object" as const,
    properties: findCardsProperties,
    required: ["listId"],
  },
  handler: findCardsTool.handler,
};

/** Arguments shared by planka_board_summary and its planka_list_lists alias. */
export interface BoardSummaryParams {
  boardId?: string;
  cardsFrom?: string[];
  highlightLabel?: string;
  limit?: number;
}

async function boardSummaryResult(params: BoardSummaryParams) {
  const summary = await getBoardSummary(params);
  return jsonResult({
    board: { id: summary.board.id, name: summary.board.name },
    lists: summary.lists,
    labels: summary.labels,
    totalCards: summary.totalCards,
    excludesArchived: true,
    ...(summary.warnings.length > 0 ? { warnings: summary.warnings } : {}),
    ...(summary.cardsFrom.length > 0 || summary.total > 0
      ? {
          cardsFrom: summary.cardsFrom,
          ...(summary.highlightLabel
            ? {
                highlightLabel: summary.highlightLabel,
                highlightedCount: summary.highlightedCount,
              }
            : {}),
          total: summary.total,
          returned: summary.returned,
          hasMore: summary.hasMore,
          cards: summary.cards,
        }
      : {}),
  });
}

/**
 * Tool: planka_board_summary
 */
export const boardSummaryTool = {
  name: "planka_board_summary",
  description:
    "The session opener: every column with its card count and every label, in one call. " +
    "Pass cardsFrom to also get the cards of those column(s) — with cardsFrom omitted (and no PLANKA_SUMMARY_DECISION_LISTS configured) it returns no cards at all. " +
    "A cardsFrom entry or a highlightLabel that matches nothing comes back in `warnings`, never as a silent empty result. " +
    "Archive and trash columns are not part of the answer (excludesArchived).",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: {
        type: "string",
        description:
          "The board ID. Optional when the server has PLANKA_DEFAULT_BOARD_ID.",
      },
      cardsFrom: {
        type: "array",
        items: { type: "string" },
        description:
          "Which column(s) to return cards from: list IDs, or name fragments matched case- and accent-insensitively (e.g. ['blocked'] or ['review','testing']). [] means columns only. Default: PLANKA_SUMMARY_DECISION_LISTS, or no cards.",
      },
      highlightLabel: {
        type: "string",
        description:
          "Label that marks a card as unblocked/ready: those cards come first and get highlighted:true. Default: PLANKA_SUMMARY_HIGHLIGHT_LABEL, or no highlighting.",
      },
      limit: {
        type: "number",
        description: "Max cards to return. Default 50, max 200.",
      },
    },
    required: ["boardId"],
  },
  handler: withPlankaErrors(async (params: BoardSummaryParams) =>
    boardSummaryResult(params)
  ),
};

/**
 * Tool: planka_list_lists — alias of planka_board_summary with cardsFrom: [].
 */
export const listListsTool = {
  name: "planka_list_lists",
  description:
    "Alias of planka_board_summary with cardsFrom: []: the columns of a board with their card counts, plus the board's labels, and no cards. " +
    "Prefer planka_board_summary.",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: {
        type: "string",
        description:
          "The board ID. Optional when the server has PLANKA_DEFAULT_BOARD_ID.",
      },
    },
    required: ["boardId"],
  },
  handler: withPlankaErrors(async (params: { boardId?: string }) =>
    boardSummaryResult({ boardId: params.boardId, cardsFrom: [] })
  ),
};

export const queryTools = [
  listCardsTool,
  listListsTool,
  boardSummaryTool,
  findCardsTool,
];
