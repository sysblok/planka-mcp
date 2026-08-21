/**
 * List tools for PLANKA MCP server.
 */
import {
  createList,
  updateList,
  deleteList,
} from "../operations/lists.js";
import { PlankaError } from "../errors.js";

/**
 * Tool: planka_manage_lists
 * Create, update, or delete lists on a board.
 */
export const manageListsTool = {
  name: "planka_manage_lists",
  description: "Create, update, or delete lists on a board.",
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
      listId: {
        type: "string",
        description: "List ID (required for update/delete)",
      },
      name: {
        type: "string",
        description: "List name",
      },
      position: {
        type: "number",
        description: "List position",
      },
      type: {
        type: "string",
        enum: ["active", "closed"],
        description: "List type. Defaults to active when creating.",
      },
    },
    required: ["action"],
  },
  handler: async (params: {
    action: "create" | "update" | "delete";
    boardId?: string;
    listId?: string;
    name?: string;
    position?: number;
    type?: "active" | "closed";
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

          const list = await createList({
            boardId: params.boardId,
            name: params.name,
            position: params.position,
            type: params.type,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    list: {
                      id: list.id,
                      name: list.name,
                      position: list.position,
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
          if (!params.listId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: listId is required for update action",
                },
              ],
              isError: true,
            };
          }

          const updates: Record<string, unknown> = {};
          if (params.name !== undefined) updates.name = params.name;
          if (params.position !== undefined) updates.position = params.position;
          if (params.type !== undefined) updates.type = params.type;

          const list = await updateList(params.listId, updates);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    list: {
                      id: list.id,
                      name: list.name,
                      position: list.position,
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
          if (!params.listId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: listId is required for delete action",
                },
              ],
              isError: true,
            };
          }

          await deleteList(params.listId);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `List ${params.listId} deleted`,
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

export const listTools = [manageListsTool];
