/**
 * Card duplication.
 *
 * `POST /api/cards/:id/duplicate` is a real Planka 2.x endpoint and it copies
 * more than the card row: verified live on 2.2.1, the response's `included`
 * came back with the card's memberships, labels, task lists, tasks and custom
 * field values. Attachments are NOT re-uploaded. The copy lands in the SAME
 * list unless `listId` (and optionally `boardId`) say otherwise, and Planka
 * appends its own suffix to the name unless `name` is given.
 *
 * The counts reported to the caller come from re-reading the new card, not
 * from this response: the point of the tool is to say what the copy actually
 * carries.
 */
import { z } from "zod";
import { plankaClient } from "../client.js";
import { assertBoardAllowed, assertListWritable } from "../config/policy.js";
import { CardBriefSchema } from "./card-brief.js";

const DuplicateResponse = z.object({ item: CardBriefSchema });

/**
 * Duplicate a card. `position` defaults to Planka's usual end-of-column value.
 */
export async function duplicateCard(input: {
  cardId: string;
  listId?: string;
  boardId?: string;
  name?: string;
  position?: number;
}): Promise<{ id: string; name: string; listId: string; boardId: string }> {
  assertListWritable(input.listId, undefined, "duplicate cards into");
  if (input.boardId) assertBoardAllowed(input.boardId);

  const body: Record<string, unknown> = { position: input.position ?? 65536 };
  if (input.listId) body.listId = input.listId;
  if (input.boardId) body.boardId = input.boardId;
  if (input.name !== undefined) body.name = input.name;

  const response = await plankaClient.post<unknown>(
    `/api/cards/${input.cardId}/duplicate`,
    body
  );
  const item = DuplicateResponse.parse(response).item;

  return {
    id: item.id,
    name: item.name,
    listId: item.listId,
    boardId: item.boardId,
  };
}
