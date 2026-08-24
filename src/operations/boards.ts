/**
 * Board operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { parseInput } from "../errors.js";
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
  GetCardsForListSchema,
  GetCardsForListInput,
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

  const response = await plankaClient.get<unknown>(`/api/boards/${boardId}`);
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
    taskLists: (included.taskLists || []).sort((a, b) => a.position - b.position),
    tasks: included.tasks || [],
  };
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
