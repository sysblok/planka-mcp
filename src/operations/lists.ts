/**
 * List operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { withBoardId } from "./board-id.js";
import { PlankaError, parseInput } from "../errors.js";
import { assertListWritable } from "../config/policy.js";
import { List } from "../schemas/entities.js";
import { ListResponse } from "../schemas/responses.js";
import {
  CreateListSchema,
  CreateListInput,
  ListIdSchema,
  ListIdInput,
  UpdateListParamsSchema,
  UpdateListParamsInput,
} from "../schemas/requests.js";

/**
 * Create a new list on a board.
 */
export async function createList(input: CreateListInput): Promise<List> {
  const validated = parseInput(CreateListSchema, input);

  return withBoardId(validated.boardId, async (boardId) => {
    const response = await plankaClient.post<unknown>(
      `/api/boards/${boardId}/lists`,
      {
        name: validated.name,
        position: validated.position,
        type: validated.type, // Required by PLANKA 2.0; defaults to "active"
      }
    );

    const parsed = ListResponse.parse(response);
    return parsed.item;
  });
}

/**
 * Update a list's properties.
 */
export async function updateList(
  input: UpdateListParamsInput
): Promise<List> {
  const { listId, ...updates } = parseInput(UpdateListParamsSchema, input);
  assertListWritable(listId, undefined, "edit");

  const response = await plankaClient.patch<unknown>(
    `/api/lists/${listId}`,
    updates
  );

  const parsed = ListResponse.parse(response);
  return parsed.item;
}

/**
 * Delete a list.
 */
export async function deleteList(input: ListIdInput): Promise<List | null> {
  const { listId } = parseInput(ListIdSchema, input);
  assertListWritable(listId, undefined, "delete");
  const body = await plankaClient.delete(`/api/lists/${listId}`);
  const parsed = ListResponse.safeParse(body);
  return parsed.success ? parsed.data.item : null;
}

/** What a column holds right now, and what kind of column it is. */
export interface ListState {
  id: string;
  /** "active" | "closed" | "archive" | "trash", when Planka will say. */
  type: string | null;
  boardId: string | null;
  cardIds: string[];
  /** Card id -> its position, so a per-card move can preserve the order. */
  positions: Map<string, number | null>;
  count: number;
}

/**
 * Reads a column: its type, its board and every card in it.
 *
 * `GET /api/lists/:id` returns the WHOLE column in `included.cards` — no 50-item
 * page, unlike `GET /api/lists/:id/cards` — which is what makes it usable both
 * as a counter and as the source of a per-card move.
 *
 * Returns `null` for a column Planka refuses to show: the hidden `archive` and
 * `trash` lists answer 404 here. That is not an error, it is information.
 */
export async function readListState(listId: string): Promise<ListState | null> {
  let response: {
    item?: { id?: string; type?: string; boardId?: string };
    included?: { cards?: Array<{ id?: string; position?: number | null }> };
  };

  try {
    response = await plankaClient.get(`/api/lists/${listId}`);
  } catch (error) {
    if (error instanceof PlankaError && error.status === 404) return null;
    throw error;
  }

  const cards = response?.included?.cards ?? [];
  const positions = new Map<string, number | null>();
  for (const card of cards) {
    if (card?.id) positions.set(card.id, card.position ?? null);
  }

  return {
    id: listId,
    type: response?.item?.type ?? null,
    boardId: response?.item?.boardId ?? null,
    cardIds: [...positions.keys()],
    positions,
    count: positions.size,
  };
}

/** How many cards a column holds. `null` when the column cannot be read. */
export async function countListCards(listId: string): Promise<number | null> {
  const state = await readListState(listId);
  return state ? state.count : null;
}

/**
 * Planka's own bulk move — and the ONLY thing it can do.
 *
 * `POST /api/lists/:id/move-cards` reads like a general "move every card from
 * A to B", and it is not: `server/api/controllers/lists/move-cards.js` in 2.2.1
 * refuses anything but archiving a whole closed column —
 *
 *     if (list.type !== List.Types.CLOSED)      throw NOT_ENOUGH_RIGHTS;   // 403
 *     if (nextList.type !== List.Types.ARCHIVE) throw LIST_NOT_FOUND;      // 404
 *
 * so an active -> active call comes back 403 "Not enough rights", which reads
 * like a permission problem and is not one. Callers that need the general move
 * fall back to `moveCardsOneByOne`.
 */
export async function bulkMoveClosedListToArchive(input: {
  fromListId: string;
  toListId: string;
}): Promise<void> {
  assertListWritable(input.toListId, undefined, "move cards into");
  assertListWritable(input.fromListId, undefined, "move cards out of");

  await plankaClient.post<unknown>(`/api/lists/${input.fromListId}/move-cards`, {
    listId: input.toListId,
  });
}

/**
 * The general move: one PATCH per card.
 *
 * Each card keeps the position it had, so the relative order survives. A card
 * whose position is null (it came out of the archive) gets one, because Planka
 * rejects a move without it.
 *
 * Returns the cards that could not be moved, with the reason — a partial move
 * has to be visible, not silently reported as a smaller success.
 */
export async function moveCardsOneByOne(input: {
  cards: Array<{ id: string; position: number | null }>;
  toListId: string;
}): Promise<Array<{ cardId: string; reason: string }>> {
  assertListWritable(input.toListId, undefined, "move cards into");

  const failed: Array<{ cardId: string; reason: string }> = [];
  for (const card of input.cards) {
    try {
      await plankaClient.patch<unknown>(`/api/cards/${card.id}`, {
        listId: input.toListId,
        position: card.position ?? 65536,
      });
    } catch (error) {
      failed.push({
        cardId: card.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failed;
}
