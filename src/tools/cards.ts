/**
 * Card tools for PLANKA MCP server.
 *
 * Every write here re-reads the card and reports what LANDED — never what was
 * asked for. See src/operations/verify.ts.
 */
import {
  createCard,
  getCard,
  getCardLight,
  updateCard,
  moveCard,
  deleteCard,
} from "../operations/cards.js";
import { UpdateCardParamsInput } from "../schemas/requests.js";
import { createTasks } from "../operations/tasks.js";
import { addLabelToCard } from "../operations/labels.js";
import {
  goneOn404,
  nothingToDo,
  verifiedDelete,
  verifiedWrite,
  writeResult,
} from "../operations/verify.js";
import { PlankaError } from "../errors.js";

/** Two date values are the same instant (or both empty). */
function sameDate(a: string | null | undefined, b: string | null | undefined) {
  const na = a ?? null;
  const nb = b ?? null;
  if (na === nb) return true;
  if (na === null || nb === null) return false;
  const ta = Date.parse(na);
  const tb = Date.parse(nb);
  return Number.isNaN(ta) || Number.isNaN(tb) ? na === nb : ta === tb;
}

/**
 * Tool: planka_create_card
 * Create a new card on a board.
 */
export const createCardTool = {
  name: "planka_create_card",
  description:
    "Create a card, optionally with tasks (checklist items) and labels. " +
    "Reports the tasks and labels that actually landed, and always returns the card id — never retry blindly on a partial failure.",
  inputSchema: {
    type: "object" as const,
    properties: {
      listId: {
        type: "string",
        description: "The list to create the card in",
      },
      name: {
        type: "string",
        description: "Card title",
      },
      description: {
        type: "string",
        description: "Card description (markdown supported)",
      },
      tasks: {
        type: "array",
        items: { type: "string" },
        description: "Optional: Task names to add as a checklist",
      },
      dueDate: {
        type: "string",
        description: "Due date in ISO format",
      },
      labelIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional: Label IDs to attach",
      },
    },
    required: ["listId", "name"],
  },
  handler: async (params: {
    listId: string;
    name: string;
    description?: string;
    tasks?: string[];
    dueDate?: string;
    labelIds?: string[];
  }) => {
    try {
      const requestedTasks = params.tasks ?? [];
      const requestedLabels = params.labelIds ?? [];

      // 1. Create the card and prove it exists.
      const created = await verifiedWrite({
        write: () =>
          createCard({
            listId: params.listId,
            name: params.name,
            description: params.description,
            dueDate: params.dueDate,
          }),
        reread: (card) => getCardLight({ cardId: card.id }),
        landed: (after, card) => after.card.id === card.id,
      });
      const card = created.result;

      const partialFailure: Record<string, unknown> = {};

      // 2. Tasks. A failure here must never cost the caller the card id.
      if (requestedTasks.length > 0) {
        try {
          await createTasks({
            cardId: card.id,
            tasks: requestedTasks.map((name) => ({ name })),
          });
        } catch (error) {
          partialFailure.tasks =
            error instanceof Error ? error.message : String(error);
        }
      }

      // 3. Labels, one by one: a bad labelId is a 404 that must not sink the rest.
      const labelErrors: string[] = [];
      for (const labelId of requestedLabels) {
        try {
          await addLabelToCard({ cardId: card.id, labelId });
        } catch {
          labelErrors.push(labelId);
        }
      }

      // 4. Read the card once more and report REALITY.
      let after = created.after;
      let readError = created.verificationError;
      if (requestedTasks.length > 0 || requestedLabels.length > 0) {
        try {
          after = await getCardLight({ cardId: card.id });
          readError = undefined;
        } catch (error) {
          readError = `the card was created but could not be re-read: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      const tasksOnCard = after
        ? requestedTasks.filter((name) =>
            after!.tasks.some((t) => t.name === name)
          ).length
        : 0;
      const finalLabelIds = after
        ? after.cardLabels.map((cl) => cl.labelId)
        : [];
      const labelsAttached = after
        ? requestedLabels.filter((id) => finalLabelIds.includes(id)).length
        : 0;

      if (labelErrors.length > 0) partialFailure.labelIds = labelErrors;
      if (after && tasksOnCard < requestedTasks.length) {
        partialFailure.tasksMissing = requestedTasks.filter(
          (name) => !after!.tasks.some((t) => t.name === name)
        );
      }

      const allLabelsFailed =
        requestedLabels.length > 0 && labelsAttached === 0;
      const ok =
        created.verified &&
        !readError &&
        Object.keys(partialFailure).length === 0 &&
        !allLabelsFailed;

      const body = {
        success: ok,
        verified: created.verified && !readError,
        ...(readError ? { verificationError: readError } : {}),
        card: {
          id: card.id,
          name: after?.card.name ?? card.name,
          listId: after?.card.listId ?? card.listId,
        },
        tasksRequested: requestedTasks.length,
        tasksCreated: tasksOnCard,
        labelsRequested: requestedLabels.length,
        labelsAttached,
        ...(after ? { finalLabelIds } : {}),
        ...(Object.keys(partialFailure).length > 0 ? { partialFailure } : {}),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
        ...(ok ? {} : { isError: true as const }),
      };
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
};

/**
 * Tool: planka_get_card
 * Get full details of a card.
 */
export const getCardTool = {
  name: "planka_get_card",
  description:
    "Get full details of a card including tasks, comments, labels, and attachments.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: {
        type: "string",
        description: "The card ID",
      },
    },
    required: ["cardId"],
  },
  handler: async (params: { cardId: string }) => {
    try {
      const details = await getCard({ cardId: params.cardId });

      const formatted = {
        card: {
          id: details.card.id,
          name: details.card.name,
          description: details.card.description,
          listId: details.card.listId,
          boardId: details.card.boardId,
          dueDate: details.card.dueDate,
          isCompleted: details.card.isCompleted,
          createdAt: details.card.createdAt,
        },
        tasks: details.tasks.map((t) => ({
          id: t.id,
          name: t.name,
          isCompleted: t.isCompleted,
        })),
        comments: details.comments.map((c) => ({
          id: c.id,
          text: c.text,
          author: c.authorName,
          createdAt: c.createdAt,
        })),
        labels: details.cardLabels.map((cl) => {
          const label = details.labels.find((l) => l.id === cl.labelId);
          return {
            id: cl.labelId,
            name: label?.name,
            color: label?.color,
          };
        }),
        attachments: details.attachments.map((a) => ({
          id: a.id,
          name: a.name,
        })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(formatted),
          },
        ],
      };
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
};

/**
 * Tool: planka_update_card
 * Update a card's properties.
 */
export const updateCardTool = {
  name: "planka_update_card",
  description:
    "Update a card (name, description, due date, completion). Reports which fields actually landed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: {
        type: "string",
        description: "The card ID",
      },
      name: {
        type: "string",
        description: "New card title",
      },
      description: {
        type: ["string", "null"],
        description: "New description (null to clear)",
      },
      dueDate: {
        type: ["string", "null"],
        description: "New due date (null to clear)",
      },
      isCompleted: {
        type: "boolean",
        description: "Mark card as complete/incomplete",
      },
    },
    required: ["cardId"],
  },
  handler: async (params: {
    cardId: string;
    name?: string;
    description?: string | null;
    dueDate?: string | null;
    isCompleted?: boolean;
  }) => {
    try {
      const { cardId, ...updates } = params;

      // Only include defined fields
      const patch: UpdateCardParamsInput = { cardId };
      if (updates.name !== undefined) patch.name = updates.name;
      if (updates.description !== undefined)
        patch.description = updates.description;
      if (updates.dueDate !== undefined) patch.dueDate = updates.dueDate;
      if (updates.isCompleted !== undefined)
        patch.isCompleted = updates.isCompleted;

      if (Object.keys(patch).length === 1) {
        return nothingToDo("name, description, dueDate, isCompleted");
      }

      const mismatches = (after: { card: Record<string, unknown> }) => {
        const bad: string[] = [];
        const c = after.card as {
          name?: string;
          description?: string | null;
          dueDate?: string | null;
          isCompleted?: boolean;
        };
        if (patch.name !== undefined && c.name !== patch.name) bad.push("name");
        if (
          patch.description !== undefined &&
          (c.description ?? null) !== (patch.description ?? null)
        )
          bad.push("description");
        if (patch.dueDate !== undefined && !sameDate(c.dueDate, patch.dueDate))
          bad.push("dueDate");
        if (
          patch.isCompleted !== undefined &&
          c.isCompleted !== patch.isCompleted
        )
          bad.push("isCompleted");
        return bad;
      };

      const written = await verifiedWrite({
        write: () => updateCard(patch),
        reread: () => getCardLight({ cardId }),
        landed: (after) => mismatches(after).length === 0,
      });

      const after = written.after;
      const notLanded = after ? mismatches(after) : [];

      return writeResult(
        {
          card: {
            id: written.result.id,
            name: after?.card.name ?? written.result.name,
            description: after?.card.description ?? written.result.description,
            dueDate: after?.card.dueDate ?? written.result.dueDate,
            isCompleted: after?.card.isCompleted ?? written.result.isCompleted,
          },
          ...(notLanded.length > 0 ? { notLanded } : {}),
        },
        written
      );
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
};

/**
 * Tool: planka_move_card
 * Move a card to a different list or position.
 */
export const moveCardTool = {
  name: "planka_move_card",
  description:
    "Move a card to another list (or board) or position — workflow transitions. Fails loudly if the card did not end up where you asked.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: {
        type: "string",
        description: "The card ID",
      },
      listId: {
        type: "string",
        description: "Target list ID",
      },
      boardId: {
        type: "string",
        description:
          "Target board ID — only when moving across boards (listId must belong to it)",
      },
      position: {
        type: "number",
        description:
          "Position in the list (lower = higher). Default: end of list",
      },
    },
    required: ["cardId", "listId"],
  },
  handler: async (params: {
    cardId: string;
    listId: string;
    boardId?: string;
    position?: number;
  }) => {
    try {
      const written = await verifiedWrite({
        write: () =>
          moveCard({
            cardId: params.cardId,
            listId: params.listId,
            boardId: params.boardId,
            position: params.position ?? 65536,
          }),
        reread: () => getCardLight({ cardId: params.cardId }),
        landed: (after) =>
          after.card.listId === params.listId &&
          (params.boardId ? after.card.boardId === params.boardId : true),
      });

      const after = written.after;

      return writeResult(
        {
          card: {
            id: written.result.id,
            name: after?.card.name ?? written.result.name,
            listId: after?.card.listId ?? written.result.listId,
            boardId: after?.card.boardId ?? written.result.boardId,
          },
          requestedListId: params.listId,
          ...(params.boardId ? { requestedBoardId: params.boardId } : {}),
          ...(after && after.card.listId !== params.listId
            ? {
                notLanded:
                  "the card is still in list " +
                  after.card.listId +
                  " — check that the listId belongs to the card's board",
              }
            : {}),
        },
        written
      );
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
};

/**
 * Tool: planka_delete_card
 * Permanently delete a card.
 */
export const deleteCardTool = {
  name: "planka_delete_card",
  description:
    "Permanently delete a card with its tasks, comments and attachments. Cannot be undone; confirmed by re-reading.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: {
        type: "string",
        description: "The card ID to delete",
      },
    },
    required: ["cardId"],
  },
  handler: async (params: { cardId: string }) => {
    try {
      const deleted = await verifiedDelete({
        del: () => deleteCard({ cardId: params.cardId }),
        confirmGone: () =>
          goneOn404(() => getCardLight({ cardId: params.cardId })),
      });

      return writeResult(
        {
          cardId: params.cardId,
          message: deleted.verified
            ? `Card ${params.cardId} deleted`
            : `Card ${params.cardId} still answers a read after the delete`,
        },
        deleted
      );
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
};

export const cardTools = [
  createCardTool,
  getCardTool,
  updateCardTool,
  moveCardTool,
  deleteCardTool,
];
