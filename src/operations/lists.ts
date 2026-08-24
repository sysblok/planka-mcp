/**
 * List operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { withBoardId } from "./board-id.js";
import { parseInput } from "../errors.js";
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
export async function deleteList(input: ListIdInput): Promise<void> {
  const { listId } = parseInput(ListIdSchema, input);
  await plankaClient.delete(`/api/lists/${listId}`);
}
