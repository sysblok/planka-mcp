/**
 * Comment tools for PLANKA MCP server.
 */
import {
  createComment,
  getCommentsForCard,
  updateComment,
  deleteComment,
} from "../operations/comments.js";
import {
  verifiedDelete,
  verifiedWrite,
  writeResult,
} from "../operations/verify.js";
import { PlankaError } from "../errors.js";

/**
 * Tool: planka_add_comment
 * Add a comment to a card.
 */
export const addCommentTool = {
  name: "planka_add_comment",
  description:
    "Comment on a card: status updates, notes, agent activity logs.",
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
  handler: async (params: { cardId: string; text: string }) => {
    try {
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
 * Tool: planka_get_comments
 * Get all comments on a card.
 */
export const getCommentsTool = {
  name: "planka_get_comments",
  description: "Get all comments on a card.",
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
      const comments = await getCommentsForCard({ cardId: params.cardId });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              cardId: params.cardId,
              commentCount: comments.length,
              comments: comments.map((c) => ({
                id: c.id,
                text: c.text,
                author: c.authorName,
                createdAt: c.createdAt,
              })),
            }),
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
 * Tool: planka_manage_comment
 * Update or delete an existing comment.
 */
export const manageCommentTool = {
  name: "planka_manage_comment",
  description:
    "Update or delete a comment, by ID from planka_get_comments. Only the agent user's own comments.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["update", "delete"],
        description: "Action to perform",
      },
      commentId: {
        type: "string",
        description: "The comment ID",
      },
      text: {
        type: "string",
        description: "New comment text (required for update)",
      },
    },
    required: ["action", "commentId"],
  },
  handler: async (params: {
    action: "update" | "delete";
    commentId: string;
    text?: string;
  }) => {
    try {
      switch (params.action) {
        case "update": {
          if (!params.text) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: text is required for update action",
                },
              ],
              isError: true,
            };
          }

          const written = await verifiedWrite({
            write: () =>
              updateComment({
                commentId: params.commentId,
                text: params.text!,
              }),
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
        }
        case "delete": {
          const deleted = await verifiedDelete({
            del: () => deleteComment({ commentId: params.commentId }),
            confirmGone: async (comment) => {
              if (!comment) return null;
              const after = await getCommentsForCard({
                cardId: comment.cardId,
              });
              return !after.some((c) => c.id === params.commentId);
            },
            unknownReason:
              "Planka did not echo the deleted comment, so its card is unknown and the delete could not be confirmed",
          });

          return writeResult(
            {
              commentId: params.commentId,
              ...(deleted.result ? { cardId: deleted.result.cardId } : {}),
              message: deleted.verified
                ? `Comment ${params.commentId} deleted`
                : `Comment ${params.commentId} delete not confirmed`,
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

export const commentTools = [addCommentTool, getCommentsTool, manageCommentTool];
