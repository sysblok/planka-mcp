/**
 * Board operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { parseInput } from "../errors.js";
import { withBoardId } from "./board-id.js";
import {
  Board,
  List,
  Card,
  Label,
  CardLabel,
  TaskList,
  Task,
} from "../schemas/entities.js";
import {
  BoardResponse,
  BoardIncludedSchema,
  CardsResponse,
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
  taskLists: TaskList[];
  tasks: Task[];
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
      taskLists: (included.taskLists || []).sort(
        (a, b) => a.position - b.position
      ),
      tasks: included.tasks || [],
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
 * Page size of GET /api/lists/:id/cards in Planka 2.x. It is not
 * configurable: `limit` is ignored and `before` is a composite cursor
 * (`before[id]` + `before[listChangedAt]`). Verified against the live API.
 *
 * Without following that cursor, a column of 77 cards answers 50 and says
 * nothing about the other 27.
 */
const LIST_CARDS_PAGE_SIZE = 50;

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

    if (parsed.items.length < LIST_CARDS_PAGE_SIZE) break;

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
// On server-side search (verified against Planka 2.x on 2026-08-24):
// GET /api/lists/:id/cards DOES accept `search=` (matching name and
// description, case-insensitive) and `labelIds=`. But it is per list: there is
// no /api/boards/:id/cards nor /api/boards/:id/labels — the SPA answers those
// with HTML. Enumerating a board's lists, or resolving a label name to its id,
// needs a GET /api/boards/:id anyway, and that single call already carries
// EVERY card with its description and cardLabels. So board-level searches
// filter locally over that one GET: adding N per-list searches would be N
// extra round-trips for no new data. What stays small is the OUTPUT.
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

/** A card at its smallest: enough to decide whether to open it. */
export interface CardDigest {
  id: string;
  name: string;
  listId: string;
  list: string;
  labels: string[];
  description?: string | null;
  dueDate?: string | null;
  isCompleted?: boolean;
}

/** Clips the description so a preview does not eat the size advantage. */
const DESCRIPTION_PREVIEW = 200;

function digest(
  card: Card,
  listName: string,
  labelNames: string[],
  withDescription: boolean
): CardDigest {
  const description = card.description ?? null;
  return {
    id: card.id,
    name: card.name,
    listId: card.listId,
    list: listName,
    labels: labelNames,
    ...(withDescription && description
      ? {
          description:
            description.length > DESCRIPTION_PREVIEW
              ? `${description.slice(0, DESCRIPTION_PREVIEW)}…`
              : description,
        }
      : {}),
    ...(card.dueDate ? { dueDate: card.dueDate } : {}),
    ...(card.isCompleted ? { isCompleted: true } : {}),
  };
}

/**
 * Indexes derived from a single GET on the board: list names, label names per
 * card, and the cards ordered the way the board shows them.
 */
async function indexBoard(boardId: string) {
  const details = await getBoard({ boardId });

  const listById = new Map(details.lists.map((l) => [l.id, l]));
  const labelById = new Map(details.labels.map((l) => [l.id, l]));

  const labelNamesByCard = new Map<string, string[]>();
  for (const cl of details.cardLabels) {
    const label = labelById.get(cl.labelId);
    if (!label) continue;
    const names = labelNamesByCard.get(cl.cardId) ?? [];
    names.push(label.name ?? label.color);
    labelNamesByCard.set(cl.cardId, names);
  }

  // Same order a human sees: by list position, then by card position.
  const listPosition = new Map(
    details.lists.map((l) => [l.id, l.position ?? Number.MAX_SAFE_INTEGER])
  );
  const cards = [...details.cards].sort((a, b) => {
    const byList =
      (listPosition.get(a.listId) ?? 0) - (listPosition.get(b.listId) ?? 0);
    return byList !== 0 ? byList : a.position - b.position;
  });

  return { details, listById, labelById, labelNamesByCard, cards };
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

/**
 * Default for `cardsFrom`: the column where cards waiting on a decision pile
 * up. Matched by name so it works on any board, whatever the language.
 */
const DECISION_LIST_HINTS = ["decision", "decide", "blocked", "bloquead"];

export interface BoardSummary {
  board: Board;
  lists: ListWithCardCount[];
  labels: { id: string; name: string }[];
  highlightLabel: string;
  cardsFrom: string[];
  cards: (CardDigest & { highlighted: boolean })[];
  highlightedCount: number;
  returned: number;
  total: number;
  hasMore: boolean;
}

/**
 * Everything needed to open a working session, in one call: columns with
 * counts, the board's labels, and the cards sitting in the column(s) waiting
 * on a decision, flagged by whether they already got one.
 */
export async function getBoardSummary(
  input: BoardSummaryInput
): Promise<BoardSummary> {
  const { boardId, cardsFrom, highlightLabel, limit } = parseInput(
    BoardSummarySchema,
    input
  );

  const { details, listById, labelNamesByCard, cards } = await indexBoard(boardId);

  const countByList = new Map<string, number>();
  for (const card of details.cards) {
    countByList.set(card.listId, (countByList.get(card.listId) ?? 0) + 1);
  }

  const visibleLists = details.lists.filter(
    (list): list is List & { name: string } => list.name !== null
  );

  const wanted = cardsFrom ?? DECISION_LIST_HINTS;
  const selected = selectLists(visibleLists, wanted);
  const selectedIds = new Set(selected.map((l) => l.id));

  const highlight = normalizeText(highlightLabel);
  const matching = cards
    .filter((card) => selectedIds.has(card.listId))
    .map((card) => {
      const labels = labelNamesByCard.get(card.id) ?? [];
      return {
        ...digest(card, listById.get(card.listId)?.name ?? "", labels, false),
        highlighted: labels.some((l) => normalizeText(l) === highlight),
      };
    });

  // Unblocked first: that is what gets picked up at the start of a session.
  matching.sort((a, b) => Number(b.highlighted) - Number(a.highlighted));
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
    highlightLabel,
    cardsFrom: selected.map((l) => l.name ?? l.id),
    cards: page,
    highlightedCount: matching.filter((c) => c.highlighted).length,
    returned: page.length,
    total: matching.length,
    hasMore: page.length < matching.length,
  };
}

export interface FindCardsResult {
  boardId: string;
  filters: { labelName?: string; query?: string; listId?: string };
  total: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  matches: CardDigest[];
  /** Filled in only when the requested filter does not exist on the board. */
  warning?: string;
}

/**
 * Searches a board's cards by label and/or text. Text matches both name and
 * description, case- and accent-insensitive.
 */
export async function findCards(
  input: FindCardsInput
): Promise<FindCardsResult> {
  const { boardId, labelName, query, listId, withDescription, limit, offset } =
    parseInput(FindCardsSchema, input);

  const { details, listById, labelById, labelNamesByCard, cards } =
    await indexBoard(boardId);

  const warnings: string[] = [];

  // labelName -> ids. A board can carry the same name on two labels.
  let labelIds: Set<string> | null = null;
  if (labelName) {
    const wanted = normalizeText(labelName);
    const hits = details.labels.filter(
      (l) => normalizeText(l.name ?? l.color) === wanted
    );
    if (hits.length === 0) {
      warnings.push(
        `No label named "${labelName}" on this board. Existing labels: ` +
          details.labels.map((l) => l.name ?? l.color).join(", ")
      );
    }
    labelIds = new Set(hits.map((l) => l.id));
  }

  if (listId && !listById.has(listId)) {
    warnings.push(`No list ${listId} on this board.`);
  }

  const needle = query ? normalizeText(query) : null;

  const matched = cards.filter((card) => {
    if (listId && card.listId !== listId) return false;
    if (labelIds) {
      const cardLabelIds = details.cardLabels
        .filter((cl) => cl.cardId === card.id)
        .map((cl) => cl.labelId);
      if (!cardLabelIds.some((id) => labelIds!.has(id))) return false;
    }
    if (needle) {
      const haystack = normalizeText(
        `${card.name}\n${card.description ?? ""}`
      );
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const page = matched.slice(offset, offset + limit);
  const hasMore = offset + page.length < matched.length;

  return {
    boardId,
    filters: {
      ...(labelName ? { labelName } : {}),
      ...(query ? { query } : {}),
      ...(listId ? { listId } : {}),
    },
    total: matched.length,
    returned: page.length,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + page.length } : {}),
    matches: page.map((card) =>
      digest(
        card,
        listById.get(card.listId)?.name ?? "",
        labelNamesByCard.get(card.id) ?? [],
        withDescription
      )
    ),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
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
 * Cards of ONE list, paginated outward. `limit`/`offset` are output-side:
 * Planka's API accepts neither, so the whole list is resolved through its
 * cursor and clipped here — the only way to report an honest `total`.
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
