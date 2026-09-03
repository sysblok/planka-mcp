/**
 * Card operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { parseInput } from "../errors.js";
import { assertListWritable, assertBoardAllowed } from "../config/policy.js";
import { Card, TaskList, Task, Comment, Label, CardLabel, Attachment } from "../schemas/entities.js";
import {
  CardIdSchema,
  CardIdInput,
  CreateCardSchema,
  CreateCardInput,
  MoveCardSchema,
  MoveCardInput,
  UpdateCardParamsSchema,
  UpdateCardParamsInput,
} from "../schemas/requests.js";
import { CardResponse, CardIncludedSchema } from "../schemas/responses.js";
import { getCommentsForCard, CommentWithAuthor } from "./comments.js";

/**
 * Card details with all related entities.
 */
export interface CardDetails {
  card: Card;
  taskLists: TaskList[];
  tasks: Task[];
  comments: CommentWithAuthor[];
  labels: Label[];
  cardLabels: CardLabel[];
  attachments: Attachment[];
}

/**
 * Create a new card in a list.
 */
export async function createCard(input: CreateCardInput): Promise<Card> {
  const validated = parseInput(CreateCardSchema, input);
  assertListWritable(validated.listId, undefined, "create cards in");

  const response = await plankaClient.post<unknown>(
    `/api/lists/${validated.listId}/cards`,
    {
      name: validated.name,
      description: validated.description,
      position: validated.position,
      type: validated.type, // Required for PLANKA 2.0
      dueDate: validated.dueDate,
    }
  );

  const parsed = CardResponse.parse(response);
  return parsed.item;
}

/**
 * Get a card by ID with all related entities.
 */
export async function getCard(input: CardIdInput): Promise<CardDetails> {
  const { cardId } = parseInput(CardIdSchema, input);

  // PLANKA 2.x doesn't include comments in the card response; fetch them
  // from their own endpoint alongside. Fall back to `included` (pre-2.x)
  // if that endpoint fails.
  const [response, fetchedComments] = await Promise.all([
    plankaClient.get<unknown>(`/api/cards/${cardId}`),
    getCommentsForCard({ cardId }).catch(() => null),
  ]);
  const parsed = CardResponse.parse(response);
  const included = CardIncludedSchema.parse(
    (response as Record<string, unknown>).included || {}
  );

  return {
    card: parsed.item,
    taskLists: (included.taskLists || []).sort((a, b) => a.position - b.position),
    tasks: (included.tasks || []).sort((a, b) => a.position - b.position),
    comments:
      fetchedComments ??
      (included.comments || []).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    labels: included.labels || [],
    cardLabels: included.cardLabels || [],
    attachments: included.attachments || [],
  };
}

/**
 * Update a card's properties.
 */
export async function updateCard(
  input: UpdateCardParamsInput
): Promise<Card> {
  const { cardId, ...updates } = parseInput(UpdateCardParamsSchema, input);

  const response = await plankaClient.patch<unknown>(
    `/api/cards/${cardId}`,
    updates
  );

  const parsed = CardResponse.parse(response);
  return parsed.item;
}

/**
 * Move a card to a different list/position.
 */
export async function moveCard(input: MoveCardInput): Promise<Card> {
  const validated = parseInput(MoveCardSchema, input);
  assertListWritable(validated.listId, undefined, "move cards into");
  if (validated.boardId) assertBoardAllowed(validated.boardId);

  const updatePayload: Record<string, unknown> = {
    listId: validated.listId,
    position: validated.position,
  };

  if (validated.boardId) {
    updatePayload.boardId = validated.boardId;
  }

  const response = await plankaClient.patch<unknown>(
    `/api/cards/${validated.cardId}`,
    updatePayload
  );

  const parsed = CardResponse.parse(response);
  return parsed.item;
}

/**
 * Delete a card.
 */
export async function deleteCard(input: CardIdInput): Promise<void> {
  const { cardId } = parseInput(CardIdSchema, input);
  await plankaClient.delete(`/api/cards/${cardId}`);
}
