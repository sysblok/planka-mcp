/**
 * Card operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { cacheScope } from "../request-context.js";
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
  CustomFieldGroup,
  CustomFieldValue,
  User,
  CustomFieldGroupSchema,
  CustomFieldSchema,
} from "../schemas/entities.js";
import { z } from "zod";
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
  /** The card's OWN groups. Board-level groups only come with the board show. */
  customFieldGroups: CustomFieldGroup[];
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
    customFieldGroups: included.customFieldGroups || [],
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
  /** The board's project: base custom field groups live there. */
  projectId: string | null;
  /** BOARD-level custom field groups (the card-level ones of other cards are dropped). */
  customFieldGroups: CustomFieldGroup[];
  /** Field definitions of those groups, as the board show includes them. */
  customFieldDefs: CustomField[];
}

const BOARD_NAMES_TTL_MS = 60_000;
/**
 * Keyed by `<caller>:<boardId>`, where the caller is the SHA-256 fingerprint
 * of the request's API key in HTTP mode (never the raw key) and one shared
 * slot in stdio mode. Two users of the same board must not share an entry:
 * one of them may not be allowed to read it at all.
 */
const boardNamesCache = new Map<string, { at: number; names: BoardNames }>();
/** Many users × many boards in a long-lived HTTP process: bound the map. */
const BOARD_NAMES_MAX_ENTRIES = 1000;

function boardNamesKey(boardId: string): string {
  return `${cacheScope()}:${boardId}`;
}

function rememberBoardNames(key: string, names: BoardNames): void {
  const now = Date.now();
  if (boardNamesCache.size >= BOARD_NAMES_MAX_ENTRIES) {
    for (const [k, entry] of boardNamesCache) {
      if (now - entry.at >= BOARD_NAMES_TTL_MS) boardNamesCache.delete(k);
    }
  }
  // Still full: drop the oldest insertion (Map iterates in insertion order).
  if (boardNamesCache.size >= BOARD_NAMES_MAX_ENTRIES) {
    const oldest = boardNamesCache.keys().next().value;
    if (oldest !== undefined) boardNamesCache.delete(oldest);
  }
  boardNamesCache.delete(key);
  boardNamesCache.set(key, { at: now, names });
}

/** Test seam: drops the memoized board names. */
export function clearBoardNamesCache(): void {
  boardNamesCache.clear();
}

/** Test seam: the cache keys, to prove no raw API key is ever one of them. */
export function boardNamesCacheKeys(): string[] {
  return [...boardNamesCache.keys()];
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

/** Rows of a raw `included` array that pass `schema`; the others are skipped. */
export function rowsOf<T>(schema: z.ZodType<T>, rows: unknown): T[] {
  if (!Array.isArray(rows)) return [];
  const out: T[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * One uncached board GET, turned into names. Throws on failure — the cached
 * `getBoardNames` is the forgiving wrapper.
 */
export async function fetchBoardNames(boardId: string): Promise<BoardNames> {
  const response = await plankaClient.get<unknown>(`/api/boards/${boardId}`);
  const { item, included } = response as {
    item?: { projectId?: unknown };
    included?: Record<string, unknown>;
  };
  const groups = rowsOf(CustomFieldGroupSchema, included?.customFieldGroups).filter(
    (g) => g.boardId === boardId
  );
  const names: BoardNames = {
    lists: nameIndex(included?.lists),
    labels: nameIndex(included?.labels),
    customFields: nameIndex(included?.customFields),
    projectId: typeof item?.projectId === "string" ? item.projectId : null,
    customFieldGroups: groups,
    customFieldDefs: rowsOf(CustomFieldSchema, included?.customFields),
  };
  rememberBoardNames(boardNamesKey(boardId), names);
  return names;
}

export async function getBoardNames(
  boardId: string
): Promise<BoardNames | null> {
  const cached = boardNamesCache.get(boardNamesKey(boardId));
  if (cached && Date.now() - cached.at < BOARD_NAMES_TTL_MS) {
    return cached.names;
  }

  try {
    return await fetchBoardNames(boardId);
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
