/**
 * MCP prompts: three ways to start, all of them cheap.
 *
 * A prompt costs nothing until it is invoked — Claude Code surfaces them as
 * `/mcp__planka__<name>`, Cursor from its prompt picker — so this is where the
 * "how do I open / close / triage" procedures live instead of in `instructions`.
 * They deliberately do NOT restate what tool descriptions already say; they
 * order the calls and say what to look at in the answers.
 *
 * Codex supports neither prompts nor resources, so nothing here is required for
 * correct use of the server.
 *
 * The three overlap with the workflow skills on purpose: the skills are the long
 * form for a repo that adopted the board workflow, these are the short form for
 * everyone else.
 */

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
  render: (args: Record<string, string>) => string;
}

const boardArgument: PromptArgument = {
  name: "boardId",
  description:
    "Board to work on. Optional: omit it when PLANKA_DEFAULT_BOARD_ID is configured, or let the summary resolve it.",
  required: false,
};

/** "on board <id>" or "" — keeps the rendered text readable either way. */
function onBoard(args: Record<string, string>): string {
  const boardId = args.boardId?.trim();
  return boardId ? ` on board ${boardId}` : "";
}

function boardIdNote(args: Record<string, string>): string {
  return args.boardId?.trim()
    ? ""
    : " If no board is configured as the default, call planka_get_structure once to get its ID and say which board you picked.";
}

export const PROMPTS: readonly PromptDefinition[] = [
  {
    name: "planka-open-session",
    title: "Open a Planka session",
    description:
      "Read the board the cheap way and report where it stands: columns, counts, what moved recently, what is waiting on a human.",
    arguments: [
      boardArgument,
      {
        name: "since",
        description:
          "ISO date to measure recent movement from (defaults to the last 24 hours).",
        required: false,
      },
    ],
    render: (args) => {
      const since = args.since?.trim();
      return [
        `Open the Planka board${onBoard(args)} and tell me where it stands.${boardIdNote(args)}`,
        "",
        "1. planka_board_summary first: it returns every column with its card count and every label with its ID in one call. Do not call planka_get_board.",
        `2. planka_board_activity ${since ? `since ${since}` : "for the last 24 hours"}: what moved and who moved it. Planka logs card creation, moves, member changes and task completion only — comments and edits do not appear there.`,
        "3. planka_find_cards with the listId of any column that looks decisive (blocked, waiting on a decision, ready to review): with a listId it reads a whole column in one request, nothing clipped.",
        "",
        "Then report, in this order: the shape of the board (columns and counts), what moved since the cutoff, the cards waiting on a human, and anything that looks stale or contradictory. Do not open individual cards yet — say which ones you would open and why.",
      ].join("\n");
    },
  },
  {
    name: "planka-close-card",
    title: "Close a Planka card",
    description:
      "Record a closing comment with real evidence, move the card, and prove both landed.",
    arguments: [
      {
        name: "cardId",
        description: "Card to close.",
        required: true,
      },
      {
        name: "listId",
        description:
          "Column to move the card to. Optional: without it, propose the destination and ask before moving.",
        required: false,
      },
    ],
    render: (args) => {
      const cardId = args.cardId?.trim() || "<cardId>";
      const listId = args.listId?.trim();
      return [
        `Close Planka card ${cardId}.`,
        "",
        `1. Read it whole first: planka_get_card ${cardId} with withComments, and keep paging planka_get_comments while hasMore is true. The description says how the card was born; the comments say where it stands today, and the last one usually wins. Never act on a card you have not read to the end.`,
        "2. State the evidence you actually have: what changed, where to check it, the one step that proves it, what could regress nearby, and what you could NOT verify. If a claim has no evidence, say so instead of implying it.",
        "3. planka_add_comment with that closing note.",
        listId
          ? `4. planka_move_card to list ${listId}.`
          : "4. Propose the destination column (from planka_board_summary) and ask me before moving the card.",
        "5. Check the `verified` field of both writes. A write that comes back without it confirmed nothing — re-read the card before telling me it is closed.",
        "",
        "Do not apply a human-only label (decided, tested-ok or the equivalent on this board) on my behalf.",
      ].join("\n");
    },
  },
  {
    name: "planka-board-triage",
    title: "Triage the decision columns",
    description:
      "Walk the columns that are waiting on a person and turn each card into one concrete question or next step.",
    arguments: [
      boardArgument,
      {
        name: "lists",
        description:
          "Comma-separated names of the columns to walk. Defaults to whatever the summary shows as waiting on a human.",
        required: false,
      },
    ],
    render: (args) => {
      const lists = args.lists?.trim();
      return [
        `Triage the Planka cards that are waiting on a person${onBoard(args)}.${boardIdNote(args)}`,
        "",
        "1. planka_board_summary to get the columns and their label IDs.",
        lists
          ? `2. Walk these columns, in order: ${lists}. Use planka_find_cards with each listId — one request per column, nothing clipped.`
          : "2. Pick the columns that are waiting on a human (a decision queue, a review queue, anything blocked) and walk them with planka_find_cards by listId — one request per column, nothing clipped.",
        "3. For each card, read every comment (planka_get_card with withComments, paging planka_get_comments while hasMore). A card whose thread you did not finish is a card you cannot triage.",
        "",
        "For every card report one line: what it is waiting for, who owes the next move, and how long it has been sitting there. Then rank them: what is blocking other work first, what is stale and probably dead last. Flag any card whose comments contradict its description or its column, and say which side you believe.",
        "",
        "Do not move cards or apply labels during triage. Propose; I decide.",
      ].join("\n");
    },
  },
];

const byName = new Map(PROMPTS.map((prompt) => [prompt.name, prompt]));

/** What `prompts/list` answers. Deterministic order, cacheable by the client. */
export function listPrompts() {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({
    name,
    title,
    description,
    arguments: args,
  }));
}

/** What `prompts/get` answers. Unknown name throws; a missing required argument too. */
export function getPrompt(name: string, args: Record<string, string> = {}) {
  const prompt = byName.get(name);
  if (!prompt) {
    throw new Error(
      `Unknown prompt: ${name}. Available: ${PROMPTS.map((p) => p.name).join(", ")}`
    );
  }

  const missing = prompt.arguments
    .filter((argument) => argument.required)
    .filter((argument) => !args[argument.name]?.trim())
    .map((argument) => argument.name);
  if (missing.length > 0) {
    throw new Error(
      `Prompt ${name} needs: ${missing.join(", ")}.`
    );
  }

  return {
    description: prompt.description,
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: prompt.render(args) },
      },
    ],
  };
}
