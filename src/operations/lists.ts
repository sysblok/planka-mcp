/**
 * List operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { withBoardId } from "./board-id.js";
import { parseInput } from "../errors.js";
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

/**
 * How many cards a column holds, right now.
 *
 * `GET /api/lists/:id` returns the WHOLE column in `included.cards` — no 50-item
 * page, unlike `GET /api/lists/:id/cards` — which is what makes it usable as a
 * counter. It is also the expensive way to count (a 159-card column is ~800 kB
 * on the wire), so it is only ever used to verify a bulk move, twice.
 *
 * Deliberately not parsed through a schema: this counts, it does not read.
 */
export async function countListCards(listId: string): Promise<number> {
  const response = await plankaClient.get<{ included?: { cards?: unknown[] } }>(
    `/api/lists/${listId}`
  );
  return response?.included?.cards?.length ?? 0;
}

/**
 * Empties one column into another in a single Planka call.
 *
 * `POST /api/lists/:id/move-cards {listId}` is Planka's own bulk move; doing it
 * card by card would be N PATCHes and N chances to stop halfway. It answers
 * `{item, included:{cards, actions}}`, but the answer is not the proof — the
 * caller counts both columns before and after.
 */
export async function moveListCards(input: {
  fromListId: string;
  toListId: string;
}): Promise<void> {
  assertListWritable(input.toListId, undefined, "move cards into");
  assertListWritable(input.fromListId, undefined, "move cards out of");

  await plankaClient.post<unknown>(`/api/lists/${input.fromListId}/move-cards`, {
    listId: input.toListId,
  });
}
