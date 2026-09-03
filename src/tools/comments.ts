/**
 * Comment tools for PLANKA MCP server.
 */
import {
  createComment,
  getComments,
  getCommentsForCard,
  updateComment,
  deleteComment,
  COMMENTS_PAGE_SIZE,
  COMMENTS_MAX_PAGES,
} from "../operations/comments.js";
import {
  verifiedDelete,
  verifiedWrite,
  writeResult,
} from "../operations/verify.js";
import { PlankaError } from "../errors.js";
import { dispatchAction } from "./dispatch.js";
import { guarded } from "./guard.js";

/**
 * Tool: planka_create_comment
 */
export const createCommentTool = {
  name: "planka_create_comment",
  description:
    "Comment on a card: status updates, notes, agent activity logs. Verified by re-reading the card's comments.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: {
        type: "string",
        description: "The card ID",
      },
      text: {
        type: "string",
        description: "Comment text (markdown supported)",
      },
    },
    required: ["cardId", "text"],
  },
  handler: async (params: { cardId: string; text: string }) =>
    guarded(async () => {
      const written = await verifiedWrite({
        write: () =>
          createComment({ cardId: params.cardId, text: params.text }),
        reread: () => getCommentsForCard({ cardId: params.cardId }),
        landed: (comments, comment) =>
          comments.some((c) => c.id === comment.id && c.text === params.text),
      });

      return writeResult(
        {
          cardId: params.cardId,
          comment: {
            id: written.result.id,
            text: written.result.text,
            createdAt: written.result.createdAt,
          },
        },
        written
      );
    }),
};

/**
 * Tool: planka_add_comment (DEPRECATED alias of planka_create_comment)
 */
export const addCommentTool = {
  name: "planka_add_comment",
  description:
    "DEPRECATED: use planka_create_comment. Kept so existing callers keep working; it forwards every argument unchanged.",
  inputSchema: createCommentTool.inputSchema,
  // Routed through dispatchAction so the alias inherits planka_create_comment's
  // access policy instead of walking around PLANKA_DISABLED_TOOLS.
  handler: (params: { cardId: string; text: string }) =>
    dispatchAction(
      "planka_add_comment",
      { ...params, action: "create" },
      { create: createCommentTool }
    ),
};

/** Comments returned when the caller does not say. Planka's page holds 50. */
const DEFAULT_LIMIT = 20;

/**
 * Tool: planka_get_comments
 * One honest page of a card's comments, oldest first.
 */
export const getCommentsTool = {
  name: "planka_get_comments",
  description:
    "Read a card's comments, oldest first. Planka serves them 50 at a time: this returns `limit` of them (default 20) plus hasMore and nextBeforeId to continue. " +
    'Use all:true to walk every page (up to ' + COMMENTS_MAX_PAGES + ' of them, then truncated:true). commentCount is what THIS response carries, never the card total.',
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: {
        type: "string",
        description: "The card ID",
      },
      limit: {
        type: "number",
        description: `How many comments to return (default 20, max ${COMMENTS_PAGE_SIZE} — Planka's page size).`,
      },
      beforeId: {
        type: "string",
        description:
          "Cursor: returns comments OLDER than this comment id. Pass the nextBeforeId of the previous answer.",
      },
      all: {
        type: "boolean",
        description:
          `Read every page instead of one (up to ${COMMENTS_MAX_PAGES} pages). Sets truncated:true if the card has even more.`,
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description:
          'Reading order: "asc" (default) oldest first, the order the thread was written; "desc" newest first.',
      },
    },
    required: ["cardId"],
  },
  handler: async (params: {
    cardId: string;
    limit?: number;
    beforeId?: string;
    all?: boolean;
    order?: "asc" | "desc";
  }) => {
    try {
      const result = await getComments({
        cardId: params.cardId,
        ...(params.all ? { all: true } : { limit: params.limit ?? DEFAULT_LIMIT }),
        ...(params.beforeId ? { beforeId: params.beforeId } : {}),
        order: params.order ?? "asc",
      });

      const body: Record<string, unknown> = {
        cardId: params.cardId,
        // Comments in THIS response. The card's real total only ever comes
        // from planka_get_card (Planka's own commentsTotal).
        commentCount: result.comments.length,
        order: params.order ?? "asc",
        hasMore: result.hasMore,
        ...(result.nextBeforeId ? { nextBeforeId: result.nextBeforeId } : {}),
        ...(result.truncated
          ? {
              truncated: true,
              truncatedReason: `stopped after ${result.pagesFetched} pages of ${COMMENTS_PAGE_SIZE}; pass beforeId=nextBeforeId to keep reading`,
            }
          : {}),
        comments: result.comments.map((c) => ({
          id: c.id,
          text: c.text,
          author: c.authorName,
          createdAt: c.createdAt,
        })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(body),
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
 * Tool: planka_update_comment
 */
export const updateCommentTool = {
  name: "planka_update_comment",
  description:
    "Rewrite a comment, by ID from planka_get_comments. Only the agent user's own comments. Verified by re-reading the card's comments.",
  inputSchema: {
    type: "object" as const,
    properties: {
      commentId: { type: "string", description: "The comment ID" },
      text: { type: "string", description: "New comment text (markdown supported)" },
    },
    required: ["commentId", "text"],
  },
  handler: async (params: { commentId: string; text: string }) =>
    guarded(async () => {
      const written = await verifiedWrite({
        write: () =>
          updateComment({ commentId: params.commentId, text: params.text }),
        reread: (comment) => getCommentsForCard({ cardId: comment.cardId }),
        landed: (comments) =>
          comments.some(
            (c) => c.id === params.commentId && c.text === params.text
          ),
      });

      return writeResult(
        {
          cardId: written.result.cardId,
          comment: {
            id: written.result.id,
            text: written.result.text,
            updatedAt: written.result.updatedAt,
          },
        },
        written
      );
    }),
};

/**
 * Tool: planka_delete_comment
 */
export const deleteCommentTool = {
  name: "planka_delete_comment",
  description:
    "Delete a comment, by ID from planka_get_comments. Only the agent user's own comments. Confirmed by re-reading the card's comments.",
  inputSchema: {
    type: "object" as const,
    properties: {
      commentId: { type: "string", description: "The comment ID" },
    },
    required: ["commentId"],
  },
  handler: async (params: { commentId: string }) =>
    guarded(async () => {
      const deleted = await verifiedDelete({
        del: () => deleteComment({ commentId: params.commentId }),
        confirmGone: async (comment) => {
          if (!comment) return null;
          const after = await getCommentsForCard({ cardId: comment.cardId });
          return !after.some((c) => c.id === params.commentId);
        },
        unknownReason:
          "Planka did not echo the deleted comment, so its card is unknown and the delete could not be confirmed — call planka_get_comments on the card to see whether it is gone",
      });

      return writeResult(
        {
          commentId: params.commentId,
          ...(deleted.result ? { cardId: deleted.result.cardId } : {}),
          message: deleted.verified
            ? `Comment ${params.commentId} deleted`
            : `Comment ${params.commentId} delete NOT confirmed — check with planka_get_comments before retrying`,
        },
        deleted
      );
    }),
};

/**
 * Tool: planka_manage_comment (DEPRECATED alias)
 */
export const manageCommentTool = {
  name: "planka_manage_comment",
  description:
    "DEPRECATED: use planka_update_comment / planka_delete_comment (and planka_create_comment to write one). Kept so existing callers keep working; it only routes `action` to those tools.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["update", "delete"],
        description: "Action to perform",
      },
      commentId: { type: "string", description: "The comment ID" },
      text: { type: "string", description: "New comment text (required for update)" },
    },
    required: ["action", "commentId"],
  },
  handler: async (params: {
    action: "update" | "delete";
    commentId: string;
    text?: string;
  }) =>
    dispatchAction("planka_manage_comment", params, {
      update: updateCommentTool,
      delete: deleteCommentTool,
    }),
};

export const commentTools = [
  createCommentTool,
  getCommentsTool,
  updateCommentTool,
  deleteCommentTool,
  addCommentTool,
  manageCommentTool,
];
