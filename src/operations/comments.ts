/**
 * Comment operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { parseInput } from "../errors.js";
import { Comment } from "../schemas/entities.js";
import {
  CardIdSchema,
  CardIdInput,
  CommentIdSchema,
  CommentIdInput,
  CreateCommentSchema,
  CreateCommentInput,
  UpdateCommentParamsSchema,
  UpdateCommentParamsInput,
} from "../schemas/requests.js";
import { CommentResponse, CommentsResponse, CommentsIncludedSchema } from "../schemas/responses.js";

/**
 * A comment enriched with its author's display name (when the API
 * includes the user record).
 */
export interface CommentWithAuthor extends Comment {
  authorName?: string;
}

/**
 * Add a comment to a card.
 */
export async function createComment(input: CreateCommentInput): Promise<Comment> {
  const validated = parseInput(CreateCommentSchema, input);

  const response = await plankaClient.post<unknown>(
    `/api/cards/${validated.cardId}/comments`,
    {
      text: validated.text,
    }
  );

  const parsed = CommentResponse.parse(response);
  return parsed.item;
}

/**
 * Update a comment's text.
 */
export async function updateComment(
  input: UpdateCommentParamsInput
): Promise<Comment> {
  const { commentId, ...updates } = parseInput(UpdateCommentParamsSchema, input);

  const response = await plankaClient.patch<unknown>(
    `/api/comments/${commentId}`,
    updates
  );

  const parsed = CommentResponse.parse(response);
  return parsed.item;
}

/**
 * Delete a comment.
 */
export async function deleteComment(input: CommentIdInput): Promise<Comment | null> {
  const { commentId } = parseInput(CommentIdSchema, input);
  const body = await plankaClient.delete(`/api/comments/${commentId}`);
  const parsed = CommentResponse.safeParse(body);
  return parsed.success ? parsed.data.item : null;
}

/**
 * Get all comments for a card, newest first.
 * PLANKA 2.x serves comments only from the dedicated endpoint — the card
 * response's `included` never carries them.
 */
export async function getCommentsForCard(
  input: CardIdInput
): Promise<CommentWithAuthor[]> {
  const { cardId } = parseInput(CardIdSchema, input);
  const response = await plankaClient.get<unknown>(
    `/api/cards/${cardId}/comments`
  );
  const parsed = CommentsResponse.parse(response);
  const included = CommentsIncludedSchema.parse(
    (response as Record<string, unknown>).included || {}
  );
  const users = included.users || [];

  return parsed.items
    .map((c) => ({
      ...c,
      authorName: users.find((u) => u.id === c.userId)?.name,
    }))
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}
