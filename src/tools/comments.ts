/**
 * Comment tools for PLANKA MCP server.
 */
import {
  createComment,
  getCommentsForCard,
  updateComment,
  deleteComment,
} from "../operations/comments.js";
import { PlankaError } from "../errors.js";

/**
 * Tool: planka_add_comment
 * Add a comment to a card.
 */
export const addCommentTool = {
  name: "planka_add_comment",
  description:
    "Add a comment to a card. Use this for status updates, notes, or agent activity logs.",
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
      const comment = await createComment({
        cardId: params.cardId,
        text: params.text,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                comment: {
                  id: comment.id,
                  text: comment.text,
                  createdAt: comment.createdAt,
                },
              },
              null,
              2
            ),
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
            text: JSON.stringify(
              {
                cardId: params.cardId,
                commentCount: comments.length,
                comments: comments.map((c) => ({
                  id: c.id,
                  text: c.text,
                  author: c.authorName,
                  createdAt: c.createdAt,
                })),
              },
              null,
              2
            ),
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
    "Update or delete an existing comment (get IDs from planka_get_comments). Only comments created by the agent user can be modified.",
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
          const comment = await updateComment({
            commentId: params.commentId,
            text: params.text,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    comment: {
                      id: comment.id,
                      text: comment.text,
                      updatedAt: comment.updatedAt,
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
          await deleteComment({ commentId: params.commentId });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `Comment ${params.commentId} deleted`,
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

export const commentTools = [addCommentTool, getCommentsTool, manageCommentTool];
