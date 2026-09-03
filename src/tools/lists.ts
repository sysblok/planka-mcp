/**
 * List tools for PLANKA MCP server.
 */
import { createList, updateList, deleteList } from "../operations/lists.js";
import { getBoard } from "../operations/boards.js";
import { UpdateListParamsInput } from "../schemas/requests.js";
import {
  nothingToDo,
  verifiedDelete,
  verifiedWrite,
  writeResult,
} from "../operations/verify.js";
import { PlankaError } from "../errors.js";
import { getPolicy } from "../config/policy.js";

/**
 * Tool: planka_manage_lists
 * Create, update, or delete lists on a board.
 */
export const manageListsTool = {
  name: "planka_manage_lists",
  description:
    "Create, update, or delete lists (columns) on a board. DESTRUCTIVE: deleting a list deletes every card in it — move the cards out first. Verified against the board.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "delete"],
        description: "Action. `delete` takes the list's cards with it.",
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
          const boardId = params.boardId ?? getPolicy().defaultBoardId;
          if (!boardId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: boardId is required for create action (or set PLANKA_DEFAULT_BOARD_ID)",
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

          const written = await verifiedWrite({
            write: () =>
              createList({
                boardId,
                name: params.name!,
                position: params.position,
                type: params.type,
              }),
            reread: (list) => getBoard({ boardId: list.boardId }),
            landed: (board, list) =>
              board.lists.some(
                (l) => l.id === list.id && l.name === params.name
              ),
          });

          return writeResult(
            {
              list: {
                id: written.result.id,
                name: written.result.name,
                position: written.result.position,
                boardId: written.result.boardId,
              },
            },
            written
          );
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

          const updates: UpdateListParamsInput = { listId: params.listId };
          if (params.name !== undefined) updates.name = params.name;
          if (params.position !== undefined) updates.position = params.position;
          if (params.type !== undefined) updates.type = params.type;

          if (Object.keys(updates).length === 1) {
            return nothingToDo("name, position, type");
          }

          const written = await verifiedWrite({
            write: () => updateList(updates),
            reread: (list) => getBoard({ boardId: list.boardId }),
            landed: (board) => {
              const list = board.lists.find((l) => l.id === params.listId);
              if (!list) return false;
              if (updates.name !== undefined && list.name !== updates.name)
                return false;
              if (
                updates.position !== undefined &&
                list.position !== updates.position
              )
                return false;
              if (updates.type !== undefined && list.type !== updates.type)
                return false;
              return true;
            },
          });

          const onBoard = written.after?.lists.find(
            (l) => l.id === params.listId
          );

          return writeResult(
            {
              list: {
                id: written.result.id,
                name: onBoard?.name ?? written.result.name,
                position: onBoard?.position ?? written.result.position,
                type: onBoard?.type ?? written.result.type,
                boardId: written.result.boardId,
              },
            },
            written
          );
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

          const deleted = await verifiedDelete({
            del: () => deleteList({ listId: params.listId! }),
            confirmGone: async (list) => {
              if (!list) return null;
              const board = await getBoard({ boardId: list.boardId });
              return !board.lists.some((l) => l.id === params.listId);
            },
            unknownReason:
              "Planka did not echo the deleted list, so its board is unknown and the delete could not be confirmed",
          });

          return writeResult(
            {
              listId: params.listId,
              ...(deleted.result ? { boardId: deleted.result.boardId } : {}),
              message: deleted.verified
                ? `List ${params.listId} deleted, with every card it contained`
                : `List ${params.listId} delete not confirmed`,
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

export const listTools = [manageListsTool];
