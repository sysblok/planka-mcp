/**
 * List (column) tools for PLANKA MCP server.
 *
 * One tool per action: the old `planka_manage_lists` action enum could not put
 * `listId` in `required`, so the checks were hand-written and an update with
 * only an id shipped an empty PATCH that answered `success: true`.
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
import { assertBoardAllowed, getPolicy } from "../config/policy.js";
import { dispatchAction } from "./dispatch.js";
import { guarded } from "./guard.js";

const listTypeProperty = {
  type: "string",
  enum: ["active", "closed"],
  description: "List type. Defaults to active when creating.",
};

/**
 * Tool: planka_create_list
 */
export const createListTool = {
  name: "planka_create_list",
  description:
    "Create a list (column) on a board. Verified against the board after writing.",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: { type: "string", description: "Board ID" },
      name: { type: "string", description: "List name" },
      position: { type: "number", description: "List position" },
      type: listTypeProperty,
    },
    required: ["boardId", "name"],
  },
  handler: async (params: {
    boardId?: string;
    name: string;
    position?: number;
    type?: "active" | "closed";
  }) =>
    guarded(async () => {
      // Explicit, like every other write path: the allowlist must not depend
      // on a lower layer the handler does not control.
      const requested = params.boardId ?? getPolicy().defaultBoardId;
      const boardId = requested ? assertBoardAllowed(requested) : null;
      if (!boardId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: boardId is required (or set PLANKA_DEFAULT_BOARD_ID)",
            },
          ],
          isError: true as const,
        };
      }

      const written = await verifiedWrite({
        write: () =>
          createList({
            boardId,
            name: params.name,
            position: params.position,
            type: params.type,
          }),
        reread: (list) => getBoard({ boardId: list.boardId }),
        landed: (board, list) =>
          board.lists.some((l) => l.id === list.id && l.name === params.name),
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
    }),
};

/**
 * Tool: planka_update_list
 */
export const updateListTool = {
  name: "planka_update_list",
  description:
    "Rename, reposition or reclassify a list (column). Verified against the board.",
  inputSchema: {
    type: "object" as const,
    properties: {
      listId: { type: "string", description: "List ID" },
      name: { type: "string", description: "New list name" },
      position: { type: "number", description: "List position" },
      type: listTypeProperty,
    },
    required: ["listId"],
  },
  handler: async (params: {
    listId: string;
    name?: string;
    position?: number;
    type?: "active" | "closed";
  }) =>
    guarded(async () => {
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

      const onBoard = written.after?.lists.find((l) => l.id === params.listId);

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
    }),
};

/**
 * Tool: planka_delete_list
 */
export const deleteListTool = {
  name: "planka_delete_list",
  description:
    "Delete a list (column). DESTRUCTIVE: it deletes every card in it — move the cards out first with planka_move_list_cards. Confirmed by re-reading the board.",
  inputSchema: {
    type: "object" as const,
    properties: {
      listId: { type: "string", description: "List ID" },
    },
    required: ["listId"],
  },
  handler: async (params: { listId: string }) =>
    guarded(async () => {
      const deleted = await verifiedDelete({
        del: () => deleteList({ listId: params.listId }),
        confirmGone: async (list) => {
          if (!list) return null;
          const board = await getBoard({ boardId: list.boardId });
          return !board.lists.some((l) => l.id === params.listId);
        },
        unknownReason:
          "Planka did not echo the deleted list, so its board is unknown and the delete could not be confirmed — call planka_board_summary on the board to see whether the column is gone",
      });

      return writeResult(
        {
          listId: params.listId,
          ...(deleted.result ? { boardId: deleted.result.boardId } : {}),
          message: deleted.verified
            ? `List ${params.listId} deleted, with every card it contained`
            : `List ${params.listId} delete NOT confirmed — check with planka_board_summary before retrying`,
        },
        deleted
      );
    }),
};

/**
 * Tool: planka_manage_lists (DEPRECATED alias)
 */
export const manageListsTool = {
  name: "planka_manage_lists",
  description:
    "DEPRECATED: use planka_create_list / planka_update_list / planka_delete_list. Kept so existing callers keep working; it only routes `action` to those tools. delete still takes the column's cards with it.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "delete"],
        description: "Action. `delete` takes the list's cards with it.",
      },
      boardId: { type: "string", description: "Board ID (required for create)" },
      listId: {
        type: "string",
        description: "List ID (required for update/delete)",
      },
      name: { type: "string", description: "List name" },
      position: { type: "number", description: "List position" },
      type: listTypeProperty,
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
  }) =>
    dispatchAction("planka_manage_lists", params, {
      create: createListTool,
      update: updateListTool,
      delete: deleteListTool,
    }),
};

export const listTools = [
  createListTool,
  updateListTool,
  deleteListTool,
  manageListsTool,
];
