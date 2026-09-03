/**
 * Tool annotations, display titles and Anthropic `_meta` for every tool.
 *
 * Kept out of the tool modules on purpose: the four hints only make sense read
 * side by side, and a single map is what lets a test prove that no tool was
 * shipped without them.
 *
 * WHY DECLARE THEM AT ALL — the spec defaults are pessimistic:
 *
 *   readOnlyHint    default false  -> every tool "modifies its environment"
 *   destructiveHint default true   -> every tool "may destroy data"
 *   idempotentHint  default false  -> repeating a call "has extra effect"
 *   openWorldHint   default true   -> every tool "touches an open world"
 *
 * Without annotations a conformant client must treat planka_get_comments as
 * being as dangerous as planka_delete_card. So every field below is written out
 * explicitly, even where it matches a default.
 *
 * `openWorldHint` is false everywhere: the domain is one configured Planka
 * instance with a closed, enumerable set of entities (projects, boards, lists,
 * cards) — not the open web.
 *
 * `_meta` carries the two Anthropic keys Claude Code actually acts on:
 *
 *   anthropic/requiresUserInteraction  forces the permission prompt even under
 *                                      an `allow` rule or in don't-ask mode.
 *   anthropic/maxResultSizeChars       raises this tool's output ceiling.
 */

/** The four standard MCP behavioural hints, all four always spelled out. */
export interface ToolBehaviourHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Everything `tools/list` publishes about a tool beyond name/description/schema. */
export interface ToolPresentation {
  /** Human-facing display name. Precedence is title -> annotations.title -> name. */
  title: string;
  annotations: ToolBehaviourHints;
  _meta?: Record<string, unknown>;
}

/** Read-only tool: looks, never touches. */
const READ: ToolBehaviourHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Write that only adds. Running it twice creates a second thing. */
const CREATE: ToolBehaviourHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Write that converges: same arguments, same end state, nothing lost. */
const UPDATE: ToolBehaviourHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Write that can remove data. Idempotent: deleting twice ends in one place. */
const DESTRUCTIVE: ToolBehaviourHints = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Multi-action tool whose `create` branch is not idempotent and whose `delete` branch removes data. */
const DESTRUCTIVE_CREATE: ToolBehaviourHints = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Forces Claude Code to ask the user, even under an allow rule. */
const NEEDS_CONFIRMATION = {
  "anthropic/requiresUserInteraction": true,
} as const;

/**
 * Presentation for every registered tool.
 *
 * A tool missing from this map fails `tests/unit/annotations.test.ts` — that is
 * the point: a new tool cannot ship annotation-less by accident.
 */
export const toolPresentation: Record<string, ToolPresentation> = {
  // --- navigation -----------------------------------------------------------
  planka_get_structure: { title: "Get board structure", annotations: READ },
  planka_get_board: { title: "Get full board", annotations: READ },

  // --- scoped reads ---------------------------------------------------------
  planka_list_cards: { title: "List cards in a column", annotations: READ },
  planka_list_lists: { title: "List board columns", annotations: READ },
  planka_board_summary: { title: "Board summary", annotations: READ },
  planka_find_cards: { title: "Find cards", annotations: READ },

  // --- cards ----------------------------------------------------------------
  planka_create_card: { title: "Create card", annotations: CREATE },
  planka_get_card: { title: "Get card", annotations: READ },
  // Passing null clears description or dueDate, so this can lose data.
  planka_update_card: {
    title: "Update card",
    annotations: { ...UPDATE, destructiveHint: true },
  },
  planka_move_card: { title: "Move card", annotations: UPDATE },
  planka_delete_card: {
    title: "Delete card",
    annotations: DESTRUCTIVE,
    _meta: { ...NEEDS_CONFIRMATION },
  },

  // --- tasks ----------------------------------------------------------------
  planka_create_tasks: { title: "Add tasks to card", annotations: CREATE },
  planka_update_task: { title: "Update task", annotations: UPDATE },
  planka_delete_task: {
    title: "Delete task",
    annotations: DESTRUCTIVE,
    _meta: { ...NEEDS_CONFIRMATION },
  },

  // --- labels ---------------------------------------------------------------
  // delete removes the label from every card that carried it.
  planka_manage_labels: {
    title: "Manage board labels",
    annotations: DESTRUCTIVE_CREATE,
    _meta: { ...NEEDS_CONFIRMATION },
  },
  // action "remove" detaches labels; converges on the same final set.
  planka_set_card_labels: {
    title: "Set card labels",
    annotations: { ...UPDATE, destructiveHint: true },
  },

  // --- comments -------------------------------------------------------------
  planka_add_comment: { title: "Add comment", annotations: CREATE },
  planka_get_comments: { title: "Get card comments", annotations: READ },
  // One tool, two actions: the delete branch makes the whole tool sensitive.
  planka_manage_comment: {
    title: "Edit or delete comment",
    annotations: DESTRUCTIVE,
    _meta: { ...NEEDS_CONFIRMATION },
  },

  // --- lists ----------------------------------------------------------------
  // delete takes the column's cards with it.
  planka_manage_lists: {
    title: "Manage board columns",
    annotations: DESTRUCTIVE_CREATE,
    _meta: { ...NEEDS_CONFIRMATION },
  },

  // --- attachments ----------------------------------------------------------
  planka_add_attachment: { title: "Attach file to card", annotations: CREATE },
  planka_get_attachments: { title: "List card attachments", annotations: READ },
  // Returns base64 images up to 3 MB; the default per-tool ceiling clips them.
  planka_view_attachment: {
    title: "View attachment",
    annotations: READ,
    _meta: { "anthropic/maxResultSizeChars": 4_500_000 },
  },
  planka_delete_attachment: {
    title: "Delete attachment",
    annotations: DESTRUCTIVE,
    _meta: { ...NEEDS_CONFIRMATION },
  },

  // --- activity -------------------------------------------------------------
  planka_card_history: { title: "Card history", annotations: READ },
  planka_board_activity: { title: "Board activity", annotations: READ },

  // --- members --------------------------------------------------------------
  // The remove branch unassigns people; converges on the same final set.
  planka_set_card_members: {
    title: "Set card members",
    annotations: { ...UPDATE, destructiveHint: true },
  },

  // --- identity -------------------------------------------------------------
  planka_list_users: { title: "List users", annotations: READ },
  planka_whoami: { title: "Who am I", annotations: READ },

  // --- card operations ------------------------------------------------------
  // Copying twice leaves two copies.
  planka_duplicate_card: { title: "Duplicate card", annotations: CREATE },
  // Hides the card from the board. Reversible with restoreToListId, but a human
  // should know it is about to disappear from every column.
  planka_archive_card: {
    title: "Archive or restore card",
    annotations: DESTRUCTIVE,
    _meta: { ...NEEDS_CONFIRMATION },
  },
  // Empties a whole column in one call: the most far-reaching write here.
  planka_move_list_cards: {
    title: "Move all cards between columns",
    annotations: { ...UPDATE, destructiveHint: true },
    _meta: { ...NEEDS_CONFIRMATION },
  },
};

/** Tools whose `_meta` must force a user prompt. Asserted by the test suite. */
export const TOOLS_REQUIRING_USER_INTERACTION = [
  "planka_delete_card",
  "planka_delete_task",
  "planka_delete_attachment",
  "planka_manage_comment",
  "planka_manage_lists",
  "planka_manage_labels",
  "planka_archive_card",
  "planka_move_list_cards",
] as const;
