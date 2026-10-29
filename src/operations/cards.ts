/**
 * Card operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { parseInput } from "../errors.js";
import { assertListWritable, assertBoardAllowed } from "../config/policy.js";
import {
  Card,
  TaskList,
  Task,
  Label,
  CardLabel,
  Attachment,
  CardMembership,
  CustomField,
  CustomFieldValue,
  User,
} from "../schemas/entities.js";
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
import { CardResponse, CardIncludedSchema, ListResponse } from "../schemas/responses.js";

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
  /** Who is assigned to the card (junction rows). */
  cardMemberships: CardMembership[];
  /** Users referenced by the memberships and task assignees. */
  users: User[];
  customFields: CustomField[];
  customFieldValues: CustomFieldValue[];
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
    cardMemberships: included.cardMemberships || [],
    users: included.users || [],
    customFields: included.customFields || [],
    customFieldValues: included.customFieldValues || [],
  };
}

/**
 * The names behind the ids a card carries — best effort, cached.
 *
 * `GET /api/cards/:id` returns `listId` and `cardLabels`, and NOTHING that says
 * what they are called: Planka 2.x serves label names and list names only from
 * the board show. So one board GET resolves both, and its result is cached for
 * a minute because names change far more slowly than cards do.
 *
 * The same holds for custom fields of a BOARD-level group: the card show
 * carries their values but not their definitions, which only the board show
 * includes. Card-level groups still come with the card itself.
 *
 * Every failure is swallowed: this decorates a read, it never fails one, and
 * NOTHING is ever verified against this cache.
 */
export interface BoardNames {
  lists: Map<string, string | null>;
  labels: Map<string, string | null>;
  customFields: Map<string, string | null>;
}

const BOARD_NAMES_TTL_MS = 60_000;
const boardNamesCache = new Map<string, { at: number; names: BoardNames }>();

/** Test seam: drops the memoized board names. */
export function clearBoardNamesCache(): void {
  boardNamesCache.clear();
}

/** {id -> name} out of a raw `included` array, without validating the rest. */
function nameIndex(rows: unknown): Map<string, string | null> {
  const index = new Map<string, string | null>();
  if (!Array.isArray(rows)) return index;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { id, name } = row as { id?: unknown; name?: unknown };
    if (typeof id !== "string") continue;
    index.set(id, typeof name === "string" ? name : null);
  }
  return index;
}

export async function getBoardNames(
  boardId: string
): Promise<BoardNames | null> {
  const cached = boardNamesCache.get(boardId);
  if (cached && Date.now() - cached.at < BOARD_NAMES_TTL_MS) {
    return cached.names;
  }

  try {
    const response = await plankaClient.get<unknown>(`/api/boards/${boardId}`);
    const included = (response as { included?: Record<string, unknown> })
      .included;
    const names: BoardNames = {
      lists: nameIndex(included?.lists),
      labels: nameIndex(included?.labels),
      customFields: nameIndex(included?.customFields),
    };
    boardNamesCache.set(boardId, { at: Date.now(), names });
    return names;
  } catch {
    return null;
  }
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
 * Delete a card. Returns the deleted card when Planka echoes it (2.x does).
 */
export async function deleteCard(input: CardIdInput): Promise<Card | null> {
  const { cardId } = parseInput(CardIdSchema, input);
  const body = await plankaClient.delete(`/api/cards/${cardId}`);
  const parsed = CardResponse.safeParse(body);
  return parsed.success ? parsed.data.item : null;
}
