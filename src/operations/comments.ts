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
 * Planka 2.x serves comments 50 at a time and IGNORES ?limit / ?page. The only
 * cursor is `?beforeId=<id>`, and the order is id DESC (newest first).
 * Measured against the live instance — see docs/planka-2x-gotchas.md.
 */
export const COMMENTS_PAGE_SIZE = 50;

/** Ceiling for `all: true`: 10 pages = 500 comments, then `truncated`. */
export const COMMENTS_MAX_PAGES = 10;

/** One raw page of comments, newest first, exactly as Planka served it. */
export interface CommentPage {
  comments: CommentWithAuthor[];
  /** True when Planka filled the page — there may well be older comments. */
  full: boolean;
  /** Cursor for the next (older) page, or undefined when the page was empty. */
  nextBeforeId?: string;
}

/**
 * One page of a card's comments (max 50), newest first.
 * `beforeId` walks backwards in time: it returns comments OLDER than that id.
 */
export async function getCommentsPage(input: {
  cardId: string;
  beforeId?: string;
}): Promise<CommentPage> {
  const { cardId } = parseInput(CardIdSchema, { cardId: input.cardId });
  const query = input.beforeId
    ? `?beforeId=${encodeURIComponent(input.beforeId)}`
    : "";
  const response = await plankaClient.get<unknown>(
    `/api/cards/${cardId}/comments${query}`
  );
  const parsed = CommentsResponse.parse(response);
  const included = CommentsIncludedSchema.parse(
    (response as Record<string, unknown>).included || {}
  );
  const users = included.users || [];

  const comments = parsed.items
    .map((c) => ({
      ...c,
      authorName: users.find((u) => u.id === c.userId)?.name,
    }))
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

  return {
    comments,
    full: parsed.items.length >= COMMENTS_PAGE_SIZE,
    nextBeforeId: comments[comments.length - 1]?.id,
  };
}

/**
 * The FIRST page of a card's comments, newest first (max 50).
 *
 * Kept as the cheap read used by write verification: a comment that was just
 * created or edited is on page 1 by definition. Anything that has to be
 * complete — or honest about not being — goes through `getComments`.
 */
export async function getCommentsForCard(
  input: CardIdInput
): Promise<CommentWithAuthor[]> {
  const { cardId } = parseInput(CardIdSchema, input);
  const page = await getCommentsPage({ cardId });
  return page.comments;
}

export interface CommentsResult {
  /** The comments themselves, in the requested order. */
  comments: CommentWithAuthor[];
  /** Older comments exist beyond what is returned here. */
  hasMore: boolean;
  /** Pass it back as `beforeId` to continue from where this answer stopped. */
  nextBeforeId?: string;
  /** `all: true` hit the page ceiling: the card has more than we read. */
  truncated: boolean;
  /** How many server pages this call cost. */
  pagesFetched: number;
}

/**
 * Read a card's comments with honest paging.
 *
 * - `limit`     how many to return (1..50 per server page; default up to the caller)
 * - `beforeId`  cursor from a previous call — returns comments OLDER than it
 * - `all`       walk every page up to COMMENTS_MAX_PAGES, then say `truncated`
 * - `order`     "asc" (oldest first, the reading order) or "desc" (newest first)
 *
 * `hasMore` is never guessed: it is true only when Planka handed back a full
 * page, or when a page carried more comments than the caller asked for.
 */
export async function getComments(input: {
  cardId: string;
  limit?: number;
  beforeId?: string;
  all?: boolean;
  order?: "asc" | "desc";
  maxPages?: number;
}): Promise<CommentsResult> {
  const order = input.order ?? "asc";

  if (input.all) {
    const maxPages = Math.max(1, input.maxPages ?? COMMENTS_MAX_PAGES);
    const collected: CommentWithAuthor[] = [];
    let beforeId = input.beforeId;
    let pagesFetched = 0;
    let full = false;

    while (pagesFetched < maxPages) {
      const page = await getCommentsPage({ cardId: input.cardId, beforeId });
      pagesFetched += 1;
      collected.push(...page.comments);
      full = page.full;
      beforeId = page.nextBeforeId;
      if (!page.full || !beforeId) break;
    }

    // Ran out of pages while Planka still had more to give.
    const truncated = full && pagesFetched >= maxPages;
    return {
      comments: order === "asc" ? [...collected].reverse() : collected,
      hasMore: truncated,
      ...(truncated && beforeId ? { nextBeforeId: beforeId } : {}),
      truncated,
      pagesFetched,
    };
  }

  const page = await getCommentsPage({
    cardId: input.cardId,
    beforeId: input.beforeId,
  });
  const limit = Math.max(
    1,
    Math.min(input.limit ?? COMMENTS_PAGE_SIZE, COMMENTS_PAGE_SIZE)
  );
  const slice = page.comments.slice(0, limit);
  const hasMore = page.comments.length > slice.length || page.full;
  const nextBeforeId = slice[slice.length - 1]?.id;

  return {
    comments: order === "asc" ? [...slice].reverse() : slice,
    hasMore,
    ...(hasMore && nextBeforeId ? { nextBeforeId } : {}),
    truncated: false,
    pagesFetched: 1,
  };
}
