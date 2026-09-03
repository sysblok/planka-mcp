/**
 * Label tools for PLANKA MCP server.
 */
import {
  createLabel,
  updateLabel,
  deleteLabel,
  setCardLabels,
} from "../operations/labels.js";
import { getBoard } from "../operations/boards.js";
import { LabelColorSchema } from "../schemas/entities.js";
import { UpdateLabelParamsInput } from "../schemas/requests.js";
import {
  nothingToDo,
  verifiedDelete,
  verifiedWrite,
  writeResult,
} from "../operations/verify.js";
import { PlankaError } from "../errors.js";

/**
 * The 43 Planka colors as a real JSON Schema enum instead of a sentence in the
 * description. Measured: the enum costs 599 chars against the 580 of the prose
 * it replaces — so this is NOT a token saving, it is a correctness one: the
 * client now rejects a bad color before the call is made. The prose stays for
 * the runtime error message only.
 */
const LABEL_COLORS = LabelColorSchema.options as readonly string[];
const validColors = LABEL_COLORS.join(", ");

/**
 * Tool: planka_manage_labels
 * Create, update, or delete labels on a board.
 */
export const manageLabelsTool = {
  name: "planka_manage_labels",
  description:
    "Create, update, or delete labels on a board. Verified against the board's labels.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "delete"],
        description: "Action to perform",
      },
      boardId: {
        type: "string",
        description: "Board ID (required for create)",
      },
      labelId: {
        type: "string",
        description: "Label ID (required for update/delete)",
      },
      name: {
        type: "string",
        description: "Label name",
      },
      color: {
        type: "string",
        enum: LABEL_COLORS,
        description: "Label color (required for create)",
      },
    },
    required: ["action"],
  },
  handler: async (params: {
    action: "create" | "update" | "delete";
    boardId?: string;
    labelId?: string;
    name?: string;
    color?: string;
  }) => {
    try {
      switch (params.action) {
        case "create": {
          if (!params.boardId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: boardId is required for create action",
                },
              ],
              isError: true,
            };
          }
          if (!params.name) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: name is required for create action",
                },
              ],
              isError: true,
            };
          }
          if (!params.color) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: color is required for create action",
                },
              ],
              isError: true,
            };
          }

          // Validate color
          const colorParse = LabelColorSchema.safeParse(params.color);
          if (!colorParse.success) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Invalid color '${params.color}'. Valid colors: ${validColors}`,
                },
              ],
              isError: true,
            };
          }

          const written = await verifiedWrite({
            write: () =>
              createLabel({
                boardId: params.boardId!,
                name: params.name!,
                color: colorParse.data,
              }),
            reread: (label) => getBoard({ boardId: label.boardId }),
            landed: (board, label) =>
              board.labels.some(
                (l) =>
                  l.id === label.id &&
                  l.name === params.name &&
                  l.color === colorParse.data
              ),
          });

          return writeResult(
            {
              label: {
                id: written.result.id,
                name: written.result.name,
                color: written.result.color,
                boardId: written.result.boardId,
                position: written.result.position,
              },
            },
            written
          );
        }

        case "update": {
          if (!params.labelId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: labelId is required for update action",
                },
              ],
              isError: true,
            };
          }

          const updates: UpdateLabelParamsInput = { labelId: params.labelId };
          if (params.name !== undefined) updates.name = params.name;
          if (params.color !== undefined) {
            const colorParse = LabelColorSchema.safeParse(params.color);
            if (!colorParse.success) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Error: Invalid color '${params.color}'. Valid colors: ${validColors}`,
                  },
                ],
                isError: true,
              };
            }
            updates.color = colorParse.data;
          }

          if (Object.keys(updates).length === 1) {
            return nothingToDo("name, color");
          }

          const written = await verifiedWrite({
            write: () => updateLabel(updates),
            reread: (label) => getBoard({ boardId: label.boardId }),
            landed: (board) => {
              const label = board.labels.find((l) => l.id === params.labelId);
              if (!label) return false;
              if (updates.name !== undefined && label.name !== updates.name)
                return false;
              if (updates.color !== undefined && label.color !== updates.color)
                return false;
              return true;
            },
          });

          const onBoard = written.after?.labels.find(
            (l) => l.id === params.labelId
          );

          return writeResult(
            {
              label: {
                id: written.result.id,
                name: onBoard?.name ?? written.result.name,
                color: onBoard?.color ?? written.result.color,
                boardId: written.result.boardId,
              },
            },
            written
          );
        }

        case "delete": {
          if (!params.labelId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: labelId is required for delete action",
                },
              ],
              isError: true,
            };
          }

          const deleted = await verifiedDelete({
            del: () => deleteLabel({ labelId: params.labelId! }),
            confirmGone: async (label) => {
              if (!label) return null;
              const board = await getBoard({ boardId: label.boardId });
              return !board.labels.some((l) => l.id === params.labelId);
            },
            unknownReason:
              "Planka did not echo the deleted label, so its board is unknown and the delete could not be confirmed",
          });

          return writeResult(
            {
              labelId: params.labelId,
              ...(deleted.result ? { boardId: deleted.result.boardId } : {}),
              message: deleted.verified
                ? `Label ${params.labelId} deleted`
                : `Label ${params.labelId} delete not confirmed`,
            },
            deleted
          );
        }

        default:
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Unknown action '${params.action}'`,
              },
            ],
            isError: true,
          };
      }
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
 * Tool: planka_set_card_labels
 * Add or remove labels from a card.
 */
export const setCardLabelsTool = {
  name: "planka_set_card_labels",
  description:
    "Add or remove labels on a card, by label ID — never by name. IDs come from planka_board_summary.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: {
        type: "string",
        description: "The card ID",
      },
      addLabelIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Label IDs to add. Alias: `labelIds` (both are accepted and merged).",
      },
      labelIds: {
        type: "array",
        items: { type: "string" },
        description: "Alias of addLabelIds. Label IDs to add.",
      },
      removeLabelIds: {
        type: "array",
        items: { type: "string" },
        description: "Label IDs to remove",
      },
    },
    required: ["cardId"],
  },
  handler: async (params: {
    cardId: string;
    addLabelIds?: string[];
    labelIds?: string[];
    removeLabelIds?: string[];
  }) => {
    try {
      // `labelIds` is the name callers reach for first. Accepting only
      // `addLabelIds` meant the argument was dropped and the tool answered
      // `success: true, labelsAdded: 0` without touching the card.
      const toAdd = [
        ...new Set([...(params.addLabelIds ?? []), ...(params.labelIds ?? [])]),
      ];
      const toRemove = params.removeLabelIds ?? [];

      if (toAdd.length === 0 && toRemove.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Error: nothing to do — pass addLabelIds (or labelIds) and/or removeLabelIds. " +
                "Label IDs come from planka_board_summary.",
            },
          ],
          isError: true,
        };
      }

      const result = await setCardLabels({
        cardId: params.cardId,
        addLabelIds: toAdd,
        removeLabelIds: toRemove,
      });
      const ok = result.failed.length === 0;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: ok,
              verified: true,
              cardId: params.cardId,
              labelsAdded: result.added.length,
              labelsRemoved: result.removed.length,
              added: result.added,
              removed: result.removed,
              alreadyPresent: result.alreadyPresent,
              notPresent: result.notPresent,
              failed: result.failed,
              finalLabelIds: result.finalLabelIds,
            }),
          },
        ],
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

export const labelTools = [manageLabelsTool, setCardLabelsTool];
