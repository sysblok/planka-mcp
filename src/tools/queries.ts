/**
 * Scoped query tools — they avoid pulling a whole board when only one column
 * matters.
 *
 * All of them return small JSON and, when they clip, they say so (`total`,
 * `returned`, `hasMore`, `nextOffset`): the model never has to guess whether
 * it saw everything.
 */
import {
  listCards,
  getBoardListCounts,
  getBoardSummary,
  findCards,
} from "../operations/boards.js";
import { PlankaError } from "../errors.js";

/** Standard JSON response for these tools. */
function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
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

/**
 * Tool: planka_list_cards
 */
export const listCardsTool = {
  name: "planka_list_cards",
  description:
    "List the cards of ONE list/column, compact (id, name, labels, task counts, dueDate) and paginated. " +
    "Prefer this over planka_get_board whenever you only care about one column: on a ~100-card board it returns roughly 1/20th of the text. " +
    "Descriptions are OFF by default — turn them on only when you actually need them. " +
    "Returns total/returned/hasMore/nextOffset, so you always know whether you saw everything. " +
    "Get list IDs from planka_list_lists or planka_get_structure.",
  inputSchema: {
    type: "object" as const,
    properties: {
      listId: { type: "string", description: "The list (column) ID" },
      withLabels: {
        type: "boolean",
        description:
          "Resolve label names (adds one board fetch). Default true.",
      },
      withDescription: {
        type: "boolean",
        description:
          "Include a 200-char description preview per card. Default false — this is the expensive one.",
      },
      labelFilter: {
        type: "string",
        description:
          "Only return cards carrying this label name (e.g. 'decidido'; case- and accent-insensitive). Implies withLabels.",
      },
      limit: {
        type: "number",
        description: "Max cards to return. Default 25, max 200.",
      },
      offset: {
        type: "number",
        description:
          "Skip this many cards. Use the nextOffset from the previous response to page.",
      },
    },
    required: ["listId"],
  },
  handler: withPlankaErrors(
    async (params: {
      listId: string;
      withLabels?: boolean;
      withDescription?: boolean;
      labelFilter?: string;
      limit?: number;
      offset?: number;
    }) => {
      const result = await listCards(params);
      const showLabels =
        params.labelFilter !== undefined || params.withLabels !== false;

      return jsonResult({
        listId: result.listId,
        total: result.total,
        returned: result.returned,
        offset: result.offset,
        hasMore: result.hasMore,
        ...(result.nextOffset !== undefined
          ? { nextOffset: result.nextOffset }
          : {}),
        ...(result.labelFilter
          ? { labelFilter: result.labelFilter, totalInList: result.totalInList }
          : {}),
        ...(result.truncated
          ? {
              truncated: true,
              note: "PLANKA stopped paginating this list; some cards may be missing.",
            }
          : {}),
        cards: result.cards.map((c) => ({
          id: c.id,
          name: c.name,
          ...(showLabels ? { labels: c.labelNames } : {}),
          ...(c.taskCount > 0
            ? { tasks: `${c.completedTaskCount}/${c.taskCount}` }
            : {}),
          ...(c.dueDate ? { dueDate: c.dueDate } : {}),
          ...(c.isCompleted ? { isCompleted: true } : {}),
          ...(params.withDescription && c.description
            ? {
                description:
                  c.description.length > 200
                    ? `${c.description.slice(0, 200)}…`
                    : c.description,
              }
            : {}),
        })),
      });
    }
  ),
};

/**
 * Tool: planka_list_lists
 */
export const listListsTool = {
  name: "planka_list_lists",
  description:
    "List the columns of a board with how many cards each one holds — no cards, no descriptions. " +
    "Use it to see the shape of a board and pick which column to open next: it costs a few dozen lines where planka_get_board costs thousands. " +
    "planka_get_structure gives the same names but NOT the counts.",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: { type: "string", description: "The board ID" },
    },
    required: ["boardId"],
  },
  handler: withPlankaErrors(async (params: { boardId: string }) => {
    const result = await getBoardListCounts({ boardId: params.boardId });
    return jsonResult({
      board: { id: result.board.id, name: result.board.name },
      totalCards: result.totalCards,
      lists: result.lists,
    });
  }),
};

/**
 * Tool: planka_board_summary
 */
export const boardSummaryTool = {
  name: "planka_board_summary",
  description:
    "One-call briefing of a board: every column with its card count, every label, and the cards sitting in the column(s) that are waiting on a decision — flagged by whether they already carry the unblocking label. " +
    "This is the tool to open a working session with: it answers 'what is on this board and what should I pick up' without dumping the board. " +
    "By default it picks the decision column by name (matches 'decision'/'decide'/'blocked', accent-insensitive, so '🤔 Necesita tu decisión' works) and highlights the label 'decidido'; override both for other boards. " +
    "Card payload is minimal (id, name, list, labels) — follow up with planka_get_card for one card, never with planka_get_board.",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: { type: "string", description: "The board ID" },
      cardsFrom: {
        type: "array",
        items: { type: "string" },
        description:
          "Which column(s) to return cards from: list IDs, or name fragments matched case- and accent-insensitively (e.g. ['decision'] or ['probalo','miralo']). Default: columns that look like a decision queue.",
      },
      highlightLabel: {
        type: "string",
        description:
          "Label that marks a card as unblocked/ready. Default 'decidido'. Cards carrying it come first and get highlighted:true.",
      },
      limit: {
        type: "number",
        description: "Max cards to return. Default 50, max 200.",
      },
    },
    required: ["boardId"],
  },
  handler: withPlankaErrors(
    async (params: {
      boardId: string;
      cardsFrom?: string[];
      highlightLabel?: string;
      limit?: number;
    }) => {
      const summary = await getBoardSummary(params);
      return jsonResult({
        board: { id: summary.board.id, name: summary.board.name },
        lists: summary.lists,
        labels: summary.labels,
        cardsFrom: summary.cardsFrom,
        highlightLabel: summary.highlightLabel,
        highlightedCount: summary.highlightedCount,
        total: summary.total,
        returned: summary.returned,
        hasMore: summary.hasMore,
        cards: summary.cards.map((c) => ({
          id: c.id,
          name: c.name,
          list: c.list,
          labels: c.labels,
          ...(c.highlighted ? { highlighted: true } : {}),
        })),
      });
    }
  ),
};

/**
 * Tool: planka_find_cards
 */
export const findCardsTool = {
  name: "planka_find_cards",
  description:
    "Search the cards of a board by label and/or text, returning only the matches (id, name, list, labels). " +
    "Two jobs it does far cheaper than planka_get_board: sweeping every card carrying a label (labelName: 'decidido'), and checking 'does a card about X already exist?' before creating a duplicate. " +
    "query matches BOTH the card name and its description, case- and accent-insensitive; listId narrows the search to one column. " +
    "At least one of labelName / query / listId is required. Descriptions are omitted unless withDescription is set, so the answer stays a handful of lines however big the board is.",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: { type: "string", description: "The board ID" },
      labelName: {
        type: "string",
        description:
          "Only cards carrying this label name (exact name, case- and accent-insensitive). If the board has no such label, the response says so and lists the ones it does have.",
      },
      query: {
        type: "string",
        description:
          "Free text matched against card name AND description (substring, case- and accent-insensitive).",
      },
      listId: {
        type: "string",
        description: "Restrict the search to this list (column).",
      },
      withDescription: {
        type: "boolean",
        description:
          "Include a 200-char description preview per match. Default false.",
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
    },
    required: ["boardId"],
  },
  handler: withPlankaErrors(
    async (params: {
      boardId: string;
      labelName?: string;
      query?: string;
      listId?: string;
      withDescription?: boolean;
      limit?: number;
      offset?: number;
    }) => {
      const result = await findCards(params);
      return jsonResult({
        boardId: result.boardId,
        filters: result.filters,
        total: result.total,
        returned: result.returned,
        offset: result.offset,
        hasMore: result.hasMore,
        ...(result.nextOffset !== undefined
          ? { nextOffset: result.nextOffset }
          : {}),
        ...(result.warning ? { warning: result.warning } : {}),
        matches: result.matches,
      });
    }
  ),
};

export const queryTools = [
  listCardsTool,
  listListsTool,
  boardSummaryTool,
  findCardsTool,
];
