/**
 * Archiving a card, which Planka has no verb for.
 *
 * In Planka 2.x every board owns four lists, two of them invisible: besides
 * the `active`/`closed` columns there is one of type `archive` and one of type
 * `trash`. They have no name and no position, `GET /api/lists/:id` answers 404
 * for them, and the board show leaves their cards out of `included.cards`.
 *
 * Archiving is therefore just a move: `PATCH /api/cards/:id {listId: <archive>}`.
 * Verified live on 2.2.1 (2026-09-03):
 *
 *   - the card's `position` becomes null (which is why verification reads go
 *     through `getCardBrief`, not the strict card schema);
 *   - `isClosed` does NOT change — it stays false, so it is useless as proof;
 *   - `prevListId` keeps the column the card came from, which is what makes
 *     un-archiving to the right place possible.
 *
 * The only trustworthy proof is `listId === <archive list of that board>`.
 */
import { z } from "zod";
import { plankaClient } from "../client.js";
import { assertBoardAllowed } from "../config/policy.js";
import { PlankaError } from "../errors.js";

const BoardListsResponse = z.object({
  included: z
    .object({
      lists: z
        .array(
          z
            .object({
              id: z.string(),
              type: z.string().optional(),
              name: z.string().nullable().optional(),
            })
            .passthrough()
        )
        .optional(),
    })
    .passthrough()
    .optional(),
});

export interface BoardSystemLists {
  archiveListId: string | null;
  trashListId: string | null;
}

/**
 * The board's hidden lists.
 *
 * Reads the board show because it is the only response that carries them — an
 * expensive call on a large board, made once per archive operation.
 */
export async function getBoardSystemLists(
  boardId: string
): Promise<BoardSystemLists> {
  assertBoardAllowed(boardId);
  const response = await plankaClient.get<unknown>(`/api/boards/${boardId}`);
  const lists = BoardListsResponse.parse(response).included?.lists ?? [];
  return {
    archiveListId: lists.find((l) => l.type === "archive")?.id ?? null,
    trashListId: lists.find((l) => l.type === "trash")?.id ?? null,
  };
}

/**
 * Moves a card into a list by id. The one primitive archiving needs.
 *
 * `position` is optional going IN to the archive (Planka nulls it) and
 * MANDATORY coming out: an archived card has `position: null`, and a PATCH that
 * only carries `listId` is rejected with "Position must be present". Verified
 * live on 2.2.1 (2026-09-03) — the restore path was broken until it sent one.
 */
export async function moveCardToList(input: {
  cardId: string;
  listId: string;
  position?: number;
}): Promise<void> {
  await plankaClient.patch<unknown>(`/api/cards/${input.cardId}`, {
    listId: input.listId,
    ...(input.position === undefined ? {} : { position: input.position }),
  });
}

/** Thrown when the board has no archive list (should not happen in 2.x). */
export function noArchiveList(boardId: string): PlankaError {
  return new PlankaError(
    `Board ${boardId} exposes no list of type "archive", so a card cannot be archived here. ` +
      `Move the card to a "closed" column instead, or delete it with planka_delete_card.`,
    "NO_ARCHIVE_LIST",
    404
  );
}
