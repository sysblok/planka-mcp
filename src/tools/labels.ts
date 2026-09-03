/**
 * Label tools for PLANKA MCP server.
 */
import {
  createLabel,
  updateLabel,
  deleteLabel,
  setCardLabels,
} from "../operations/labels.js";
import { LabelColorSchema } from "../schemas/entities.js";
import { UpdateLabelParamsInput } from "../schemas/requests.js";
import { PlankaError } from "../errors.js";

// Valid colors for the schema description
const validColors = LabelColorSchema.options.join(", ");

/**
 * Tool: planka_manage_labels
 * Create, update, or delete labels on a board.
 */
export const manageLabelsTool = {
  name: "planka_manage_labels",
  description: "Create, update, or delete labels on a board.",
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
        description: `Label color. Valid colors: ${validColors}`,
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

          const label = await createLabel({
            boardId: params.boardId,
            name: params.name,
            color: colorParse.data,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    label: {
                      id: label.id,
                      name: label.name,
                      color: label.color,
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };
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

          const label = await updateLabel(updates);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    label: {
                      id: label.id,
                      name: label.name,
                      color: label.color,
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };
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

          await deleteLabel({ labelId: params.labelId });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `Label ${params.labelId} deleted`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
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
                "Label IDs come from planka_get_board.",
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
            text: JSON.stringify(
              {
                success: ok,
                cardId: params.cardId,
                labelsAdded: result.added.length,
                labelsRemoved: result.removed.length,
                added: result.added,
                removed: result.removed,
                alreadyPresent: result.alreadyPresent,
                notPresent: result.notPresent,
                failed: result.failed,
                finalLabelIds: result.finalLabelIds,
              },
              null,
              2
            ),
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
