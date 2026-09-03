/**
 * Board operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { parseInput, PlankaError } from "../errors.js";
import { assertBoardAllowed, getPolicy } from "../config/policy.js";
import { withBoardId } from "./board-id.js";
import {
  Board,
  List,
  Card,
  Label,
  CardLabel,
  TaskList,
  Task,
  CardMembership,
  User,
} from "../schemas/entities.js";
import {
  BoardResponse,
  BoardIncludedSchema,
  CardsResponse,
  ListResponse,
} from "../schemas/responses.js";
import {
  BoardIdSchema,
  BoardIdInput,
  BoardSummarySchema,
  BoardSummaryInput,
  FindCardsSchema,
  FindCardsInput,
  GetCardsForListSchema,
  GetCardsForListInput,
  ListCardsSchema,
  ListCardsInput,
  CardDetail,
  DEFAULT_DESCRIPTION_CHARS,
} from "../schemas/requests.js";

/**
 * Full board details with all included entities.
 */
export interface BoardDetails {
  board: Board;
  lists: List[];
  cards: Card[];
  labels: Label[];
  cardLabels: CardLabel[];
  cardMemberships: CardMembership[];
  taskLists: TaskList[];
  tasks: Task[];
  users: User[];
}

/**
 * Card with computed task counts.
 */
export interface CardWithTaskCounts extends Card {
  taskCount: number;
  completedTaskCount: number;
}

/**
 * Get a board by ID with all included entities.
 *
 * ⚠️ `GET /api/boards/:id` returns the cards of the FINITE lists only
 * (`active` + `closed`). The `archive` and `trash` lists come back nameless,
 * positionless and WITHOUT their cards. Everything derived from this call —
 * counts, searches, summaries — is therefore a view of the visible board, not
 * of everything Planka stores. Reads built on it flag it as
 * `excludesArchived: true`. See docs/planka-2x-gotchas.md.
 */
export async function getBoard(input: BoardIdInput): Promise<BoardDetails> {
  const { boardId } = parseInput(BoardIdSchema, input);

  return withBoardId(boardId, async (id) => {
    const response = await plankaClient.get<unknown>(`/api/boards/${id}`);
    const parsed = BoardResponse.parse(response);
    const included = BoardIncludedSchema.parse(
      (response as Record<string, unknown>).included || {}
    );

    return {
      board: parsed.item,
      lists: (included.lists || []).sort(
        (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity)
      ),
      cards: included.cards || [],
      labels: (included.labels || []).sort((a, b) => a.position - b.position),
      cardLabels: included.cardLabels || [],
      cardMemberships: included.cardMemberships || [],
      taskLists: (included.taskLists || []).sort(
        (a, b) => a.position - b.position
      ),
      tasks: included.tasks || [],
      users: included.users || [],
    };
  });
}

/**
 * Get a board with cards enriched with task counts.
 */
export async function getBoardWithTaskCounts(
  input: BoardIdInput
): Promise<{
  board: Board;
  lists: List[];
  cards: CardWithTaskCounts[];
  labels: Label[];
  cardLabels: CardLabel[];
}> {
  const { boardId } = parseInput(BoardIdSchema, input);
  const details = await getBoard({ boardId });

  // Build taskList -> cardId mapping (PLANKA 2.0: tasks belong to taskLists, not cards directly)
  const taskListToCard = new Map<string, string>();
  for (const taskList of details.taskLists) {
    taskListToCard.set(taskList.id, taskList.cardId);
  }

  // Build task count map by card
  const taskCountsByCard = new Map<
    string,
    { total: number; completed: number }
  >();

  for (const task of details.tasks) {
    // Get cardId via the taskList
    const cardId = taskListToCard.get(task.taskListId);
    if (!cardId) continue;

    const counts = taskCountsByCard.get(cardId) || {
      total: 0,
      completed: 0,
    };
    counts.total++;
    if (task.isCompleted) {
      counts.completed++;
    }
    taskCountsByCard.set(cardId, counts);
  }

  // Enrich cards with task counts
  const cardsWithCounts: CardWithTaskCounts[] = details.cards.map((card) => {
    const counts = taskCountsByCard.get(card.id) || { total: 0, completed: 0 };
    return {
      ...card,
      taskCount: counts.total,
      completedTaskCount: counts.completed,
    };
  });

  return {
    board: details.board,
    lists: details.lists,
    cards: cardsWithCounts,
    labels: details.labels,
    cardLabels: details.cardLabels,
  };
}

/**
 * Cards of one list with labels resolved and task counts — WITHOUT pulling the
 * whole board. Uses the native GET /api/lists/:id/cards endpoint (PLANKA 2.0),
 * which includes cardLabels/taskLists/tasks but NOT the board's labels: names
 * come from a single extra GET on the board, and only when withLabels is set.
 */
export type CardWithLabels = CardWithTaskCounts & { labelNames: string[] };

export interface ListCardsRawResult {
  cards: CardWithLabels[];
  /** true when pagination stopped before the list was exhausted. */
  truncated: boolean;
}

/**
 * Page size of GET /api/lists/:id/cards in Planka 2.x — 50 at the time of
 * writing. It is not configurable: `limit` is ignored and `before` is a
 * composite cursor (`before[id]` + `before[listChangedAt]`).
 *
 * It is NOT assumed: the first response defines it (see below). Hardcoding 50
 * against an instance that answers 20 stops the loop on page one and reports
 * `truncated: false` over a third of the column — the exact class of lie this
 * module exists to avoid. The constant is kept only as the documented
 * expectation.
 */
export const LIST_CARDS_EXPECTED_PAGE_SIZE = 50;

/** Safety ceiling: 20 pages = 1000 cards. */
const LIST_CARDS_MAX_PAGES = 20;

export async function getCardsForList(
  input: GetCardsForListInput
): Promise<ListCardsRawResult> {
  const { listId, withLabels } = parseInput(GetCardsForListSchema, input);

  const rawCards: Card[] = [];
  const cardLabels: CardLabel[] = [];
  const taskLists: TaskList[] = [];
  const tasks: Task[] = [];
  let cursor: { id: string; listChangedAt: string } | null = null;
  let truncated = false;
  // Derived from the first response, never assumed.
  let pageSize: number | null = null;

  for (let page = 0; page < LIST_CARDS_MAX_PAGES; page++) {
    let path = `/api/lists/${listId}/cards`;
    if (cursor) {
      const query = new URLSearchParams({
        "before[id]": cursor.id,
        "before[listChangedAt]": cursor.listChangedAt,
      });
      path += `?${query.toString()}`;
    }

    const response = await plankaClient.get<unknown>(path);
    const parsed = CardsResponse.parse(response);
    const included = BoardIncludedSchema.parse(
      (response as Record<string, unknown>).included || {}
    );

    rawCards.push(...parsed.items);
    cardLabels.push(...(included.cardLabels || []));
    taskLists.push(...(included.taskLists || []));
    tasks.push(...(included.tasks || []));

    // An empty answer ends the list whatever the page size is.
    if (parsed.items.length === 0) break;
    if (pageSize === null) pageSize = parsed.items.length;
    if (parsed.items.length < pageSize) break;

    const last = parsed.items[parsed.items.length - 1];
    if (!last.listChangedAt) {
      // No listChangedAt means no cursor is possible: warn instead of lying.
      truncated = true;
      break;
    }
    cursor = { id: last.id, listChangedAt: last.listChangedAt };
    if (page === LIST_CARDS_MAX_PAGES - 1) truncated = true;
  }

  const cards = rawCards.sort((a, b) => a.position - b.position);

  // labelId -> name (labels live on the board; one extra GET)
  let labelNameById = new Map<string, string>();
  if (withLabels && cards.length > 0 && cardLabels.length > 0) {
    const board = await getBoard({ boardId: cards[0].boardId });
    labelNameById = new Map(board.labels.map((l) => [l.id, l.name ?? l.color]));
  }

  const taskListToCard = new Map(taskLists.map((tl) => [tl.id, tl.cardId]));
  const counts = new Map<string, { total: number; completed: number }>();
  for (const task of tasks) {
    const cardId = taskListToCard.get(task.taskListId);
    if (!cardId) continue;
    const c = counts.get(cardId) || { total: 0, completed: 0 };
    c.total++;
    if (task.isCompleted) c.completed++;
    counts.set(cardId, c);
  }

  return {
    truncated,
    cards: cards.map((card) => {
      const c = counts.get(card.id) || { total: 0, completed: 0 };
      return {
        ...card,
        taskCount: c.total,
        completedTaskCount: c.completed,
        labelNames: cardLabels
          .filter((cl) => cl.cardId === card.id)
          .map((cl) => labelNameById.get(cl.labelId))
          .filter((n): n is string => n !== undefined),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Scoped reads — they return little on purpose
//
// Two data sources, one shape (verified against Planka 2.2.1 on 2026-09-03):
//
//   GET /api/boards/:id   every card of the visible lists, unpaginated, plus
//                         labels and list names. Archive/trash excluded.
//   GET /api/lists/:id    every card of ONE list, unpaginated, with its
//                         cardLabels/tasks/memberships. No label NAMES: those
//                         live on the board, so resolving them costs one extra
//                         GET (skip it with withLabels: false).
//
// The list show is what makes a one-column read cheap and honest: no cursor to
// follow, so `truncated` is false by construction and `total` is the real size
// of the column. There is no /api/boards/:id/cards and no global search: a
// board-wide query filters locally over the single board GET.
// ---------------------------------------------------------------------------

/** A list with its card count, without the cards. */
export interface ListWithCardCount {
  id: string;
  name: string;
  type?: string;
  cardCount: number;
}

/** Ignores case and accents: "Necesita tu decisión" matches "decision". */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Text matching, same semantics as Planka's own `?search=`:
 *   - a leading "/" makes the rest a case-insensitive regular expression;
 *   - otherwise every whitespace-separated token must appear (AND), ignoring
 *     case and accents.
 * An invalid regex is reported to the caller instead of matching nothing.
 */
export function makeMatcher(query: string): (haystack: string) => boolean {
  if (query.startsWith("/")) {
    const source = query.slice(1);
    let regex: RegExp;
    try {
      regex = new RegExp(source, "i");
    } catch (error) {
      throw new PlankaError(
        `Invalid regular expression after "/": ${source} (${(error as Error).message}). ` +
          `Drop the leading "/" to search for it as plain text.`,
        "INVALID_QUERY",
        400
      );
    }
    return (haystack) => regex.test(haystack);
  }
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  return (haystack) => {
    const normalized = normalizeText(haystack);
    return tokens.every((token) => normalized.includes(token));
  };
}

/**
 * A board seen without its cards: just the visible lists and how many cards
 * each one holds. One GET, a handful of lines of output.
 */
export async function getBoardListCounts(input: BoardIdInput): Promise<{
  board: Board;
  lists: ListWithCardCount[];
  totalCards: number;
}> {
  const { boardId } = parseInput(BoardIdSchema, input);
  const details = await getBoard({ boardId });

  const countByList = new Map<string, number>();
  for (const card of details.cards) {
    countByList.set(card.listId, (countByList.get(card.listId) ?? 0) + 1);
  }

  // name === null means archive/trash: those are not board columns.
  const lists = details.lists
    .filter((list): list is List & { name: string } => list.name !== null)
    .map((list) => ({
      id: list.id,
      name: list.name,
      ...(list.type ? { type: list.type } : {}),
      cardCount: countByList.get(list.id) ?? 0,
    }));

  return {
    board: details.board,
    lists,
    totalCards: details.cards.length,
  };
}

// ---------------------------------------------------------------------------
// Card bundles: the two sources normalised into one shape
// ---------------------------------------------------------------------------

/** Everything a read needs about a set of cards, whatever it came from. */
interface CardBundle {
  boardId: string;
  cards: Card[];
  labels: Label[];
  cardLabels: CardLabel[];
  cardMemberships: CardMembership[];
  taskLists: TaskList[];
  tasks: Task[];
  users: User[];
  /** Lists known to this bundle: the whole board, or the single list read. */
  lists: List[];
  /** False when label names were not fetched (withLabels: false). */
  labelsResolved: boolean;
}

/** Per-card lookups derived from a bundle, built once per call. */
interface CardIndex {
  listNameById: Map<string, string>;
  labelNamesByCard: Map<string, string[]>;
  labelIdsByCard: Map<string, string[]>;
  memberNamesByCard: Map<string, string[]>;
  memberIdsByCard: Map<string, Set<string>>;
  taskCounts: Map<string, { total: number; completed: number }>;
}

function indexBundle(bundle: CardBundle): CardIndex {
  const labelById = new Map(bundle.labels.map((l) => [l.id, l]));
  const userById = new Map(bundle.users.map((u) => [u.id, u]));

  const labelNamesByCard = new Map<string, string[]>();
  const labelIdsByCard = new Map<string, string[]>();
  for (const cl of bundle.cardLabels) {
    const ids = labelIdsByCard.get(cl.cardId) ?? [];
    ids.push(cl.labelId);
    labelIdsByCard.set(cl.cardId, ids);

    const label = labelById.get(cl.labelId);
    if (!label) continue;
    const names = labelNamesByCard.get(cl.cardId) ?? [];
    names.push(label.name ?? label.color);
    labelNamesByCard.set(cl.cardId, names);
  }

  const memberNamesByCard = new Map<string, string[]>();
  const memberIdsByCard = new Map<string, Set<string>>();
  for (const cm of bundle.cardMemberships) {
    const ids = memberIdsByCard.get(cm.cardId) ?? new Set<string>();
    ids.add(cm.userId);
    memberIdsByCard.set(cm.cardId, ids);

    const names = memberNamesByCard.get(cm.cardId) ?? [];
    names.push(userById.get(cm.userId)?.name ?? cm.userId);
    memberNamesByCard.set(cm.cardId, names);
  }

  const taskListToCard = new Map(bundle.taskLists.map((tl) => [tl.id, tl.cardId]));
  const taskCounts = new Map<string, { total: number; completed: number }>();
  for (const task of bundle.tasks) {
    const cardId = taskListToCard.get(task.taskListId);
    if (!cardId) continue;
    const counts = taskCounts.get(cardId) ?? { total: 0, completed: 0 };
    counts.total++;
    if (task.isCompleted) counts.completed++;
    taskCounts.set(cardId, counts);

    // Planka's own userIds filter matches members OR task assignees.
    if (task.assigneeUserId) {
      const ids = memberIdsByCard.get(cardId) ?? new Set<string>();
      ids.add(task.assigneeUserId);
      memberIdsByCard.set(cardId, ids);
    }
  }

  return {
    listNameById: new Map(
      bundle.lists.map((l) => [l.id, l.name ?? ""] as [string, string])
    ),
    labelNamesByCard,
    labelIdsByCard,
    memberNamesByCard,
    memberIdsByCard,
    taskCounts,
  };
}

/** The whole board as a bundle: one GET, every visible card. */
async function boardBundle(boardId: string | undefined): Promise<{
  bundle: CardBundle;
  details: BoardDetails;
}> {
  const details = await getBoard({ boardId });
  const listPosition = new Map(
    details.lists.map((l) => [l.id, l.position ?? Number.MAX_SAFE_INTEGER])
  );
  // Same order a human sees: by list position, then by card position.
  const cards = [...details.cards].sort((a, b) => {
    const byList =
      (listPosition.get(a.listId) ?? 0) - (listPosition.get(b.listId) ?? 0);
    return byList !== 0 ? byList : a.position - b.position;
  });

  return {
    details,
    bundle: {
      boardId: details.board.id,
      cards,
      labels: details.labels,
      cardLabels: details.cardLabels,
      cardMemberships: details.cardMemberships,
      taskLists: details.taskLists,
      tasks: details.tasks,
      users: details.users,
      lists: details.lists,
      labelsResolved: true,
    },
  };
}

/**
 * ONE list as a bundle, through `GET /api/lists/:id`: every card of the
 * column in a single response, no cursor, no page ceiling. Label names need
 * the board, so they cost one extra GET and only when asked for.
 */
async function listBundle(
  listId: string,
  withLabels: boolean
): Promise<{ bundle: CardBundle; list: List }> {
  const response = await plankaClient.get<unknown>(`/api/lists/${listId}`);
  const list = ListResponse.parse(response).item;
  const included = BoardIncludedSchema.parse(
    (response as Record<string, unknown>).included || {}
  );

  // The list names its board: check that board against the allowlist before
  // handing any of its content back.
  assertBoardAllowed(list.boardId);

  const cards = [...(included.cards || [])].sort(
    (a, b) => a.position - b.position
  );

  let labels: Label[] = [];
  if (withLabels) {
    const board = await getBoard({ boardId: list.boardId });
    labels = board.labels;
  }

  return {
    list,
    bundle: {
      boardId: list.boardId,
      cards,
      labels,
      cardLabels: included.cardLabels || [],
      cardMemberships: included.cardMemberships || [],
      taskLists: included.taskLists || [],
      tasks: included.tasks || [],
      users: included.users || [],
      lists: [list],
      labelsResolved: withLabels,
    },
  };
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/** A card at its smallest: enough to decide whether to open it. */
export interface CardDigest {
  id: string;
  name: string;
  /**
   * The column the card is in — same field name as planka_get_card. Present
   * whenever the result spans more than one column; on the single-column path
   * the response root carries `list: {id, name}` instead.
   */
  listId?: string;
  /** Only when the result spans more than one column. */
  listName?: string;
  labels?: string[];
  /** Always present when the card has labels: what set_card_labels needs. */
  labelIds?: string[];
  members?: string[];
  /** "completed/total", only when the card has checklist items. */
  tasks?: string;
  dueDate?: string;
  commentsTotal?: number;
  updatedAt?: string;
  description?: string;
  /** detail: "full" only. */
  boardId?: string;
  position?: number;
  type?: string;
  createdAt?: string;
  isClosed?: boolean;
  isDueCompleted?: boolean;
  isCompleted?: boolean;
}

interface DigestOptions {
  detail: CardDetail;
  /** 0 leaves the description out entirely. */
  descriptionChars: number;
  withLabels: boolean;
  /** False when every card is known to be in the same column. */
  withListName: boolean;
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

function toDigest(
  card: Card,
  index: CardIndex,
  options: DigestOptions
): CardDigest {
  const full = options.detail === "full";
  const counts = index.taskCounts.get(card.id);
  const members = index.memberNamesByCard.get(card.id) ?? [];
  const description = card.description ?? null;

  const digest: CardDigest = {
    id: card.id,
    name: card.name,
  };

  if (options.withListName) {
    // Same names and same meanings as planka_get_card's `card.listId` /
    // `card.listName`: one vocabulary across the two digests, so a match can be
    // moved without a third call to find out where it lives. Omitted on the
    // single-column path only because the response root already carries
    // `list: {id, name}` — the id is never actually missing.
    digest.listId = card.listId;
    digest.listName = index.listNameById.get(card.listId) ?? "";
  }
  if (options.withLabels) {
    // Empty arrays are omitted; the response says once, at its root, whether
    // label names were resolved at all — so a missing `labels` is never
    // ambiguous while still costing nothing per card.
    const labelNames = index.labelNamesByCard.get(card.id) ?? [];
    if (labelNames.length > 0) digest.labels = labelNames;
  }
  // IDs travel with the names, in digest too: planka_set_card_labels takes ids
  // and only ids, and find_cards used to publish the names alone — which sent
  // the model back to planka_board_summary for data it already had.
  const labelIds = index.labelIdsByCard.get(card.id) ?? [];
  if (labelIds.length > 0) digest.labelIds = labelIds;
  if (members.length > 0) digest.members = members;
  if (counts && counts.total > 0) {
    digest.tasks = `${counts.completed}/${counts.total}`;
  }
  if (card.dueDate) digest.dueDate = card.dueDate;
  if (card.commentsTotal) digest.commentsTotal = card.commentsTotal;
  if (card.updatedAt) digest.updatedAt = card.updatedAt;
  if (description !== null) {
    if (full) digest.description = description;
    else if (options.descriptionChars > 0) {
      digest.description = clip(description, options.descriptionChars);
    }
  }

  if (full) {
    digest.listId = card.listId;
    digest.boardId = card.boardId;
    digest.position = card.position;
    digest.type = card.type;
    digest.createdAt = card.createdAt;
    if (card.isClosed) digest.isClosed = true;
    if (card.isDueCompleted ?? card.isDueDateCompleted) {
      digest.isDueCompleted = true;
    }
  }
  if (card.isCompleted) digest.isCompleted = true;

  return digest;
}

/**
 * The lists whose cards the caller asked for. Each entry matches an exact id
 * or a name fragment (accent- and case-insensitive).
 */
function selectLists(lists: List[], wanted: string[]): List[] {
  const selected: List[] = [];
  for (const list of lists) {
    if (list.name === null) continue;
    const name = normalizeText(list.name);
    const hit = wanted.some(
      (w) => w === list.id || name.includes(normalizeText(w))
    );
    if (hit) selected.push(list);
  }
  return selected;
}

/** Which `cardsFrom`/`listName` entries matched nothing at all. */
function unmatchedHints(lists: List[], wanted: string[]): string[] {
  return wanted.filter(
    (w) =>
      !lists.some(
        (l) =>
          l.name !== null &&
          (w === l.id || normalizeText(l.name).includes(normalizeText(w)))
      )
  );
}

export interface BoardSummary {
  board: Board;
  lists: ListWithCardCount[];
  labels: { id: string; name: string }[];
  totalCards: number;
  highlightLabel?: string;
  cardsFrom: string[];
  cards: (CardDigest & { highlighted?: boolean })[];
  highlightedCount: number;
  returned: number;
  total: number;
  hasMore: boolean;
  warnings: string[];
}

/**
 * Everything needed to open a working session, in one call: columns with
 * counts, the board's labels, and — when asked — the cards of the columns
 * named in `cardsFrom`, flagged by whether they carry `highlightLabel`.
 *
 * With `cardsFrom: []` (or with neither argument nor
 * PLANKA_SUMMARY_DECISION_LISTS) it answers the shape of the board and no
 * cards at all: that is what `planka_list_lists` now is.
 */
export async function getBoardSummary(
  input: BoardSummaryInput
): Promise<BoardSummary> {
  const { boardId, cardsFrom, highlightLabel, limit } = parseInput(
    BoardSummarySchema,
    input
  );
  const policy = getPolicy();

  const { bundle, details } = await boardBundle(boardId);
  const index = indexBundle(bundle);
  const warnings: string[] = [];

  const countByList = new Map<string, number>();
  for (const card of details.cards) {
    countByList.set(card.listId, (countByList.get(card.listId) ?? 0) + 1);
  }

  const visibleLists = details.lists.filter(
    (list): list is List & { name: string } => list.name !== null
  );

  const wanted = cardsFrom ?? policy.summaryDecisionLists ?? [];
  const selected = selectLists(visibleLists, wanted);

  if (wanted.length > 0) {
    const missed = unmatchedHints(visibleLists, wanted);
    if (missed.length > 0) {
      warnings.push(
        `cardsFrom matched no column for: ${missed.join(", ")}. Columns on this board: ` +
          visibleLists.map((l) => l.name).join(", ")
      );
    }
  }

  const highlight = highlightLabel ?? policy.summaryHighlightLabel ?? null;
  if (
    highlight !== null &&
    !details.labels.some(
      (l) => normalizeText(l.name ?? l.color) === normalizeText(highlight)
    )
  ) {
    warnings.push(
      `No label named "${highlight}" on this board, so no card is highlighted. Labels: ` +
        details.labels.map((l) => l.name ?? l.color).join(", ")
    );
  }

  const selectedIds = new Set(selected.map((l) => l.id));
  const options: DigestOptions = {
    detail: "digest",
    descriptionChars: 0,
    withLabels: true,
    withListName: true,
  };

  const matching: (CardDigest & { highlighted?: boolean })[] =
    selectedIds.size === 0
      ? []
      : bundle.cards
          .filter((card) => selectedIds.has(card.listId))
          .map((card) => {
            const labels = index.labelNamesByCard.get(card.id) ?? [];
            const digest = toDigest(card, index, options);
            return highlight !== null &&
              labels.some((l) => normalizeText(l) === normalizeText(highlight))
              ? { ...digest, highlighted: true }
              : digest;
          });

  // Unblocked first: that is what gets picked up at the start of a session.
  matching.sort(
    (a, b) =>
      Number("highlighted" in b && b.highlighted) -
      Number("highlighted" in a && a.highlighted)
  );
  const page = matching.slice(0, limit);

  return {
    board: details.board,
    lists: visibleLists.map((list) => ({
      id: list.id,
      name: list.name,
      ...(list.type ? { type: list.type } : {}),
      cardCount: countByList.get(list.id) ?? 0,
    })),
    labels: details.labels.map((l) => ({ id: l.id, name: l.name ?? l.color })),
    totalCards: details.cards.length,
    ...(highlight !== null ? { highlightLabel: highlight } : {}),
    cardsFrom: selected.map((l) => l.name ?? l.id),
    cards: page,
    highlightedCount: matching.filter((c) => c.highlighted).length,
    returned: page.length,
    total: matching.length,
    hasMore: page.length < matching.length,
    warnings,
  };
}

export interface FindCardsResult {
  boardId: string;
  /** Present when the search was scoped to a single column. */
  list?: { id: string; name: string | null };
  filters: {
    listId?: string;
    listName?: string;
    labelName?: string;
    labelIds?: string[];
    userIds?: string[];
    query?: string;
  };
  detail: CardDetail;
  /** "list" = one GET on the column; "board" = the board index. */
  source: "list" | "board";
  /** False when label names were not fetched: `labels` is absent everywhere. */
  labelsResolved: boolean;
  /** Only on the list path: the column came back whole, no cursor involved. */
  truncated?: false;
  /** Only on the board path: archive/trash lists are not in the board show. */
  excludesArchived?: true;
  total: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  matches: CardDigest[];
  warnings: string[];
}

/**
 * The one search over a board's cards.
 *
 * With `listId` it reads that column alone (`GET /api/lists/:id`): one call,
 * unpaginated, so `total` is the real size of the column and nothing can be
 * silently clipped. Without it, it filters over a single board read.
 */
export async function findCards(
  input: FindCardsInput
): Promise<FindCardsResult> {
  const params = parseInput(FindCardsSchema, input);
  const {
    boardId,
    listId,
    listName,
    labelIds,
    userIds,
    query,
    withLabels,
    detail,
    limit,
    offset,
  } = params;
  const labelName = params.labelName ?? params.labelFilter;

  const warnings: string[] = [];
  const descriptionChars =
    params.descriptionChars ??
    (params.withDescription ? DEFAULT_DESCRIPTION_CHARS : 0);
  // Label names are needed for the filter, and for anything but a bare digest.
  const needLabels = withLabels || labelName !== undefined || detail === "full";

  let bundle: CardBundle;
  let scopedList: List | null = null;
  let source: "list" | "board";
  let listIdsFilter: Set<string> | null = null;

  if (listId) {
    const read = await listBundle(listId, needLabels);
    bundle = read.bundle;
    scopedList = read.list;
    source = "list";
  } else {
    const read = await boardBundle(boardId);
    bundle = read.bundle;
    source = "board";

    if (listName) {
      const hits = selectLists(bundle.lists, [listName]);
      if (hits.length === 0) {
        warnings.push(
          `No column matching "${listName}" on this board. Columns: ` +
            bundle.lists
              .filter((l) => l.name !== null)
              .map((l) => l.name)
              .join(", ")
        );
      }
      if (hits.length === 1) scopedList = hits[0];
      listIdsFilter = new Set(hits.map((l) => l.id));
    }
  }

  const index = indexBundle(bundle);

  // labelName -> ids. A board can carry the same name on two labels.
  let labelNameIds: Set<string> | null = null;
  if (labelName) {
    if (!bundle.labelsResolved) {
      // Cannot happen through the tools (needLabels covers it), but a direct
      // caller must not get a silent zero.
      throw new PlankaError(
        "labelName needs the board's labels; do not pass withLabels: false with it.",
        "INVALID_ARGUMENTS",
        400
      );
    }
    const wanted = normalizeText(labelName);
    const hits = bundle.labels.filter(
      (l) => normalizeText(l.name ?? l.color) === wanted
    );
    if (hits.length === 0) {
      warnings.push(
        `No label named "${labelName}" on this board. Existing labels: ` +
          bundle.labels.map((l) => l.name ?? l.color).join(", ")
      );
    }
    labelNameIds = new Set(hits.map((l) => l.id));
  }

  const wantedLabelIds = labelIds ? new Set(labelIds) : null;
  const wantedUserIds = userIds ? new Set(userIds) : null;
  const matches = query ? makeMatcher(query) : null;

  const matched = bundle.cards.filter((card) => {
    if (listIdsFilter && !listIdsFilter.has(card.listId)) return false;

    const cardLabelIds = index.labelIdsByCard.get(card.id) ?? [];
    if (labelNameIds && !cardLabelIds.some((id) => labelNameIds.has(id))) {
      return false;
    }
    if (wantedLabelIds && !cardLabelIds.some((id) => wantedLabelIds.has(id))) {
      return false;
    }
    if (wantedUserIds) {
      const cardUserIds = index.memberIdsByCard.get(card.id);
      if (!cardUserIds) return false;
      let hit = false;
      for (const id of cardUserIds) if (wantedUserIds.has(id)) hit = true;
      if (!hit) return false;
    }
    if (matches && !matches(`${card.name}\n${card.description ?? ""}`)) {
      return false;
    }
    return true;
  });

  const page = matched.slice(offset, offset + limit);
  const hasMore = offset + page.length < matched.length;
  // The column name is hoisted out of every card when they all share it.
  const singleColumn =
    source === "list" || (listIdsFilter !== null && listIdsFilter.size === 1);

  const options: DigestOptions = {
    detail,
    descriptionChars,
    withLabels: needLabels,
    withListName: !singleColumn,
  };

  return {
    boardId: bundle.boardId,
    ...(scopedList
      ? { list: { id: scopedList.id, name: scopedList.name } }
      : {}),
    filters: {
      ...(listId ? { listId } : {}),
      ...(listName ? { listName } : {}),
      ...(labelName ? { labelName } : {}),
      ...(labelIds ? { labelIds } : {}),
      ...(userIds ? { userIds } : {}),
      ...(query ? { query } : {}),
    },
    detail,
    source,
    labelsResolved: needLabels,
    ...(source === "list" ? { truncated: false as const } : {}),
    ...(source === "board" ? { excludesArchived: true as const } : {}),
    total: matched.length,
    returned: page.length,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + page.length } : {}),
    matches: page.map((card) => toDigest(card, index, options)),
    warnings,
  };
}

export interface ListCardsResult {
  listId: string;
  listName?: string;
  total: number;
  totalInList: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  truncated: boolean;
  labelFilter?: string;
  cards: CardWithLabels[];
}

/**
 * Cards of ONE list, paginated outward, through the cursor of
 * `GET /api/lists/:id/cards`.
 *
 * Kept for callers that want the raw card records; `planka_list_cards` no
 * longer goes through here — it is an alias of findCards({ listId }), which
 * gets the same cards in ONE request via the list show.
 */
export async function listCards(
  input: ListCardsInput
): Promise<ListCardsResult> {
  const { listId, withLabels, labelFilter, limit, offset } = parseInput(
    ListCardsSchema,
    input
  );

  const { cards, truncated } = await getCardsForList({
    listId,
    withLabels: labelFilter !== undefined ? true : withLabels,
  });

  const wanted = labelFilter ? normalizeText(labelFilter) : null;
  const matched = wanted
    ? cards.filter((c) => c.labelNames.some((l) => normalizeText(l) === wanted))
    : cards;

  const page = matched.slice(offset, offset + limit);
  const hasMore = offset + page.length < matched.length;

  return {
    listId,
    total: matched.length,
    totalInList: cards.length,
    returned: page.length,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + page.length } : {}),
    truncated,
    ...(labelFilter ? { labelFilter } : {}),
    cards: page,
  };
}
