/**
 * Navigation tools for PLANKA MCP server.
 */
import { getStructure } from "../operations/projects.js";
import { getBoardWithTaskCounts } from "../operations/boards.js";

/**
 * Tool: planka_get_structure
 * Get the full project/board/list hierarchy.
 */
export const getStructureTool = {
  name: "planka_get_structure",
  description:
    "Get the full project/board/list structure. Use this to understand what projects and boards exist before working with cards.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectId: {
        type: "string",
        description: "Optional: Get structure for a specific project only",
      },
    },
  },
  handler: async (params: { projectId?: string }) => {
    const structure = await getStructure(params.projectId);

    // Format for readability
    const formatted = structure.map((project) => ({
      project: {
        id: project.project.id,
        name: project.project.name,
      },
      boards: project.boards.map((b) => ({
        id: b.board.id,
        name: b.board.name,
        lists: b.lists
          .filter((l) => l.name !== null) // Filter out archive/trash
          .map((l) => ({
            id: l.id,
            name: l.name,
          })),
      })),
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(formatted, null, 2),
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
    "Get a board with all its lists, cards, and labels. Use this to see everything on a board.",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: {
        type: "string",
        description: "The board ID",
      },
      includeTaskCounts: {
        type: "boolean",
        description: "Include task completion counts for each card",
        default: true,
      },
    },
    required: ["boardId"],
  },
  handler: async (params: { boardId: string; includeTaskCounts?: boolean }) => {
    const details = await getBoardWithTaskCounts(params.boardId);

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

    const formatted = {
      board: {
        id: details.board.id,
        name: details.board.name,
      },
      labels: details.labels.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
      })),
      lists: details.lists
        .filter((l) => l.name !== null) // Filter archive/trash
        .map((list) => {
          const listCards = (cardsByList.get(list.id) || []).sort(
            (a, b) => a.position - b.position
          );
          return {
            id: list.id,
            name: list.name,
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

              if (params.includeTaskCounts !== false && card.taskCount > 0) {
                cardData.tasks = `${card.completedTaskCount}/${card.taskCount}`;
              }

              return cardData;
            }),
          };
        }),
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(formatted, null, 2),
        },
      ],
    };
  },
};

export const navigationTools = [getStructureTool, getBoardTool];
