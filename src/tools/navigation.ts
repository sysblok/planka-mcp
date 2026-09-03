/**
 * Navigation tools for PLANKA MCP server.
 */
import { getStructure } from "../operations/projects.js";
import { getBoardWithTaskCounts } from "../operations/boards.js";
import { parseInput } from "../errors.js";
import { GetBoardSchema } from "../schemas/requests.js";

/**
 * Tool: planka_get_structure
 * Get the full project/board/list hierarchy.
 */
export const getStructureTool = {
  name: "planka_get_structure",
  description:
    "Projects, boards and lists with their IDs. The source of the IDs every other tool needs. " +
    "Columns cost one board read per board: pass withLists: false for the projects and boards alone, in a single request.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectId: {
        type: "string",
        description: "Optional: Get structure for a specific project only",
      },
      withLists: {
        type: "boolean",
        description:
          "Include each board's columns. Default true; false answers projects and boards in one request (planka_board_summary also lists the columns, with their counts).",
      },
    },
  },
  handler: async (params: { projectId?: string; withLists?: boolean }) => {
    const structure = await getStructure({
      projectId: params.projectId,
      withLists: params.withLists,
    });

    // Format for readability
    const formatted = structure.map((project) => ({
      project: {
        id: project.project.id,
        name: project.project.name,
      },
      boards: project.boards.map((b) => ({
        id: b.board.id,
        name: b.board.name,
        ...(params.withLists === false
          ? {}
          : {
              lists: b.lists
                .filter((l) => l.name !== null) // Filter out archive/trash
                .map((l) => ({
                  id: l.id,
                  name: l.name,
                })),
            }),
      })),
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(formatted),
        },
      ],
    };
  },
};

/**
 * Tool: planka_get_board
 * Get a board with all its lists, cards, and labels.
 */
export const getBoardTool = {
  name: "planka_get_board",
  description:
    "DEPRECATED: use planka_board_summary + planka_find_cards. " +
    "Whole board in one payload: every list, card and label — the most expensive read of the set, and it grows with the board. " +
    "It returns at most `limit` cards (50 by default) and reports total/truncated when it clips. " +
    "Archive and trash columns are never included (excludesArchived).",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: {
        type: "string",
        description:
          "The board ID. Optional when the server has PLANKA_DEFAULT_BOARD_ID.",
      },
      includeTaskCounts: {
        type: "boolean",
        description: "Include task completion counts for each card",
        default: true,
      },
      limit: {
        type: "number",
        description:
          "Max cards across the whole board. Default 50, max 200. Beyond it the response carries truncated: true.",
      },
    },
    required: ["boardId"],
  },
  handler: async (params: {
    boardId?: string;
    includeTaskCounts?: boolean;
    limit?: number;
  }) => {
    const { boardId, includeTaskCounts, limit } = parseInput(
      GetBoardSchema,
      params
    );
    const details = await getBoardWithTaskCounts({ boardId });

    // Group cards by list for readability
    const cardsByList = new Map<string, typeof details.cards>();
    for (const card of details.cards) {
      const listCards = cardsByList.get(card.listId) || [];
      listCards.push(card);
      cardsByList.set(card.listId, listCards);
    }

    // Build label lookup
    const labelById = new Map(details.labels.map((l) => [l.id, l]));

    // Build card-label lookup
    const labelsByCard = new Map<string, string[]>();
    for (const cl of details.cardLabels) {
      const labels = labelsByCard.get(cl.cardId) || [];
      const label = labelById.get(cl.labelId);
      if (label) {
        labels.push(label.name || label.color);
      }
      labelsByCard.set(cl.cardId, labels);
    }

    // Cards are handed out in board order until `limit` runs out; the rest is
    // reported, never dropped in silence.
    let budget = limit;
    const totalCards = details.cards.length;

    const formatted = {
      board: {
        id: details.board.id,
        name: details.board.name,
      },
      deprecated:
        "planka_get_board is deprecated: use planka_board_summary for the shape of the board and planka_find_cards for its cards.",
      excludesArchived: true,
      totalCards,
      labels: details.labels.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
      })),
      lists: details.lists
        .filter((l) => l.name !== null) // Filter archive/trash
        .map((list) => {
          const allListCards = (cardsByList.get(list.id) || []).sort(
            (a, b) => a.position - b.position
          );
          const listCards = allListCards.slice(0, Math.max(budget, 0));
          budget -= listCards.length;
          return {
            id: list.id,
            name: list.name,
            cardCount: allListCards.length,
            ...(listCards.length < allListCards.length
              ? { returned: listCards.length }
              : {}),
            cards: listCards.map((card) => {
              const cardData: Record<string, unknown> = {
                id: card.id,
                name: card.name,
              };

              if (card.description) {
                cardData.description =
                  card.description.length > 100
                    ? card.description.substring(0, 100) + "..."
                    : card.description;
              }

              if (card.dueDate) {
                cardData.dueDate = card.dueDate;
              }

              if (card.isCompleted) {
                cardData.isCompleted = card.isCompleted;
              }

              const cardLabels = labelsByCard.get(card.id);
              if (cardLabels && cardLabels.length > 0) {
                cardData.labels = cardLabels;
              }

              if (includeTaskCounts !== false && card.taskCount > 0) {
                cardData.tasks = `${card.completedTaskCount}/${card.taskCount}`;
              }

              return cardData;
            }),
          };
        }),
    };

    const returnedCards = limit - budget;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ...formatted,
            returnedCards,
            ...(returnedCards < totalCards
              ? {
                  truncated: true,
                  note: `Only ${returnedCards} of ${totalCards} cards are in this response. Raise limit, or read one column with planka_find_cards({listId}).`,
                }
              : {}),
          }),
        },
      ],
    };
  },
};

export const navigationTools = [getStructureTool, getBoardTool];
