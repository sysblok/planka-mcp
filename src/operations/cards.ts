/**
 * Card operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { parseInput } from "../errors.js";
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
 * Card details without comments (one GET, no comment traffic).
 */
export interface CardLightDetails {
  card: Card;
  taskLists: TaskList[];
  tasks: Task[];
  labels: Label[];
  cardLabels: CardLabel[];
  attachments: Attachment[];
}

/**
 * Card details with all related entities.
 */
export interface CardDetails extends CardLightDetails {
  comments: CommentWithAuthor[];
}

/**
 * Create a new card in a list.
 */
export async function createCard(input: CreateCardInput): Promise<Card> {
  const validated = parseInput(CreateCardSchema, input);

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
 * Get a card WITHOUT its comments — one GET, no comment traffic.
 *
 * This is the read used for write verification and by setCardLabels: pulling
 * every comment of a card just to compare label ids was pure waste.
 */
export async function getCardLight(input: CardIdInput): Promise<CardLightDetails> {
  const { cardId } = parseInput(CardIdSchema, input);

  const response = await plankaClient.get<unknown>(`/api/cards/${cardId}`);
  const parsed = CardResponse.parse(response);
  const included = CardIncludedSchema.parse(
    (response as Record<string, unknown>).included || {}
  );

  return {
    card: parsed.item,
    taskLists: (included.taskLists || []).sort((a, b) => a.position - b.position),
    tasks: (included.tasks || []).sort((a, b) => a.position - b.position),
    labels: included.labels || [],
    cardLabels: included.cardLabels || [],
    attachments: included.attachments || [],
  };
}

/**
 * Get a card by ID with all related entities, comments included.
 *
 * PLANKA 2.x never carries comments in the card response, so they come from
 * their own endpoint. A failure there PROPAGATES on purpose: swallowing it
 * into `comments: []` told the agent "this card has no comments" when the
 * truth was "I could not read them" — the single most expensive lie this
 * server can tell on a board whose memory lives in the comments.
 */
export async function getCard(input: CardIdInput): Promise<CardDetails> {
  const { cardId } = parseInput(CardIdSchema, input);

  const [light, comments] = await Promise.all([
    getCardLight({ cardId }),
    getCommentsForCard({ cardId }),
  ]);

  return { ...light, comments };
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
 * Delete a card. Returns the deleted card when Planka echoes it (2.x does).
 */
export async function deleteCard(input: CardIdInput): Promise<Card | null> {
  const { cardId } = parseInput(CardIdSchema, input);
  const body = await plankaClient.delete(`/api/cards/${cardId}`);
  const parsed = CardResponse.safeParse(body);
  return parsed.success ? parsed.data.item : null;
}
