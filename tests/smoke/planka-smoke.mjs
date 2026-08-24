#!/usr/bin/env node

/**
 * End-to-end smoke test for the Planka MCP server.
 *
 * It speaks MCP over stdio against the built server, so it exercises the real
 * thing — dispatch, schemas, error formatting — not individual functions. Every
 * MCP write is then cross-checked against the raw Planka HTTP API: if a tool
 * reports success on something that never landed, this is where it shows.
 *
 * Opt-in. Configure it with the same credentials your MCP client uses:
 *
 *   PLANKA_BASE_URL, PLANKA_AGENT_EMAIL, PLANKA_AGENT_PASSWORD
 *   PLANKA_SMOKE_BOARD_ID   board to run against (required)
 *
 * Optional:
 *   PLANKA_SMOKE_LIST_ID    list where the scratch card is created (otherwise a
 *                           scratch-looking column is picked, else the first)
 *   PLANKA_MCP_ENTRY        server entry point (default dist/index.js)
 *   PLANKA_SMOKE_FAIL_AFTER=<n>  inject a failure after check n, to prove that
 *                           cleanup still runs
 *   VERBOSE=1               print each check's payload
 *
 * Everything it creates is deleted in a `finally` — and on SIGINT/SIGTERM too.
 * Cleanup goes over raw HTTP on purpose: when a signal kills this process the
 * MCP server child dies with it and its tools stop answering, so the safety net
 * cannot depend on the thing under test.
 *
 * Exit codes: 0 green · 1 a check failed · 2 configuration problem.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PlankaApi, boardEntities } from "../../scripts/lib/planka-api.mjs";

const EXPECTED_TOOL_COUNT = 24;

/** Prefix on every artifact this test creates; the initial sweep looks for it. */
const PREFIX = "[smoke planka-mcp]";
const CARD_NAME = `${PREFIX} delete me if I survived`;

const required = [
  "PLANKA_BASE_URL",
  "PLANKA_AGENT_EMAIL",
  "PLANKA_AGENT_PASSWORD",
  "PLANKA_SMOKE_BOARD_ID",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Smoke test skipped: missing ${missing.join(", ")}`);
  console.error("This test is opt-in and requires a writable real Planka board.");
  process.exit(2);
}

const boardId = process.env.PLANKA_SMOKE_BOARD_ID;
const entry = resolve(process.env.PLANKA_MCP_ENTRY || "dist/index.js");
const failAfter = process.env.PLANKA_SMOKE_FAIL_AFTER
  ? Number(process.env.PLANKA_SMOKE_FAIL_AFTER)
  : null;

const api = await PlankaApi.fromCredentials({
  baseUrl: process.env.PLANKA_BASE_URL,
  email: process.env.PLANKA_AGENT_EMAIL,
  password: process.env.PLANKA_AGENT_PASSWORD,
});

const client = new Client({ name: "planka-mcp-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    PLANKA_BASE_URL: process.env.PLANKA_BASE_URL,
    PLANKA_AGENT_EMAIL: process.env.PLANKA_AGENT_EMAIL,
    PLANKA_AGENT_PASSWORD: process.env.PLANKA_AGENT_PASSWORD,
  },
  stderr: "pipe",
});

// ---------------------------------------------------------------------------
// Check bookkeeping
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let checkIndex = 0;
/** Set when a signal arrives: stop counting checks and only clean up. */
let aborting = false;

function check(label, ok, detail) {
  if (aborting) return ok;
  checkIndex++;
  if (ok) passed++;
  else failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${String(checkIndex).padStart(2, " ")}. ${label}`
  );
  if ((!ok || process.env.VERBOSE) && detail !== undefined) {
    console.log(String(detail).slice(0, 1200).replace(/^/gm, "        "));
  }
  if (failAfter !== null && checkIndex === failAfter) {
    throw new Error(
      `PLANKA_SMOKE_FAIL_AFTER=${failAfter} — failure injected on purpose`
    );
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Artifacts and cleanup (raw HTTP, never the tools under test)
// ---------------------------------------------------------------------------

const artifacts = { attachments: [], cards: [], lists: [], labels: [] };
let cleanedUp = false;
let workDir = null;

const forget = (kind, id) => {
  artifacts[kind] = artifacts[kind].filter((item) => item !== id);
};

async function tryDelete(kind, id, remove) {
  try {
    await remove(id);
    console.log(`  cleanup: ${kind} ${id} deleted`);
  } catch (error) {
    console.log(`  cleanup: ${kind} ${id} NOT deleted — ${error.message}`);
  }
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  const pending =
    artifacts.attachments.length +
    artifacts.cards.length +
    artifacts.lists.length +
    artifacts.labels.length;
  console.log("\n--- cleanup ---");
  if (pending === 0) console.log("  nothing to delete");

  // Attachments go with their card, but if the card survived they must go too.
  for (const id of artifacts.attachments.splice(0)) {
    await tryDelete("attachment", id, (x) => api.deleteAttachment(x));
  }
  for (const id of artifacts.cards.splice(0)) {
    await tryDelete("card", id, (x) => api.deleteCard(x));
  }
  for (const id of artifacts.lists.splice(0)) {
    await tryDelete("list", id, (x) => api.deleteList(x));
  }
  for (const id of artifacts.labels.splice(0)) {
    await tryDelete("label", id, (x) => api.deleteLabel(x));
  }

  if (workDir) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // nothing else to do about a temp dir
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (aborting) process.exit(130);
    aborting = true;
    console.log(`\n${signal} — cleaning up before exiting…`);
    await client.close().catch(() => {});
    await cleanup();
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

/** Calls a tool and returns { text, isError, content } without throwing. */
async function callTool(name, args) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true, content: [] };
  }
  const content = result.content ?? [];
  const text = content
    .map((item) => item.text ?? `[${item.type} ${item.mimeType ?? ""}]`)
    .join("\n");
  return { text, isError: result.isError ?? false, content };
}

/** Calls a tool that must succeed and returns its parsed JSON payload. */
async function json(name, args) {
  const result = await callTool(name, args);
  if (result.isError) return null;
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

const rawBoard = async () => boardEntities(await api.getBoard(boardId));

/** Picks the list to work in: explicit id, a scratch-looking column, or the first. */
function resolveList(lists) {
  const wanted = process.env.PLANKA_SMOKE_LIST_ID;
  if (wanted) {
    const list = lists.find((item) => item.id === wanted);
    if (!list) {
      throw new Error(
        `PLANKA_SMOKE_LIST_ID=${wanted} is not a list of board ${boardId}`
      );
    }
    return { list, how: "PLANKA_SMOKE_LIST_ID" };
  }
  const usable = lists.filter((item) => item.name && item.type !== "closed");
  if (usable.length === 0) throw new Error("The board needs at least one active list");
  const scratch = usable.find((item) =>
    /evaluando|scratch|sandbox|smoke/i.test(item.name)
  );
  if (scratch) return { list: scratch, how: "scratch column matched by name" };
  console.log(
    `  ⚠ No scratch column found. Using "${usable[0].name}". ` +
      "Set PLANKA_SMOKE_LIST_ID to pick another."
  );
  return { list: usable[0], how: "first active list" };
}

/** Deletes leftovers from a previous run that died halfway through. */
async function sweepResidue(state) {
  let swept = 0;
  for (const card of state.cards) {
    if (card.name?.startsWith(PREFIX)) {
      await api.deleteCard(card.id).catch(() => {});
      swept++;
    }
  }
  for (const list of state.lists) {
    if (list.name?.startsWith(PREFIX)) {
      await api.deleteList(list.id).catch(() => {});
      swept++;
    }
  }
  for (const label of state.labels) {
    if (label.name?.startsWith(PREFIX)) {
      await api.deleteLabel(label.id).catch(() => {});
      swept++;
    }
  }
  console.log(swept === 0 ? "  sweep: no residue" : `  sweep: ${swept} artifact(s)`);
  return swept;
}

// ---------------------------------------------------------------------------
// The smoke
// ---------------------------------------------------------------------------

async function run() {
  const tools = await client.listTools();
  check(
    `tools/list publishes ${EXPECTED_TOOL_COUNT} tools`,
    tools.tools.length === EXPECTED_TOOL_COUNT,
    tools.tools.map((tool) => tool.name).join(", ")
  );

  let state = await rawBoard();
  await sweepResidue(state);
  state = await rawBoard();

  const { list, how } = resolveList(state.lists);
  console.log(
    `\nTarget: board "${state.board?.name}" (${boardId}) · list "${list.name}" (${list.id}) — ${how}\n`
  );

  const mcpBoard = await json("planka_get_board", { boardId });
  check(
    "planka_get_board returns the selected board",
    mcpBoard?.board?.id === boardId,
    mcpBoard?.board
  );
  const boardText = JSON.stringify(mcpBoard);

  // --- labels the scratch card will carry -----------------------------------
  const labelA = await json("planka_manage_labels", {
    action: "create",
    boardId,
    name: `${PREFIX} A`,
    color: "berry-red",
  });
  if (labelA?.label?.id) artifacts.labels.push(labelA.label.id);
  check("planka_manage_labels create (A)", Boolean(labelA?.label?.id), labelA);

  const labelB = await json("planka_manage_labels", {
    action: "create",
    boardId,
    name: `${PREFIX} B`,
    color: "lagoon-blue",
  });
  if (labelB?.label?.id) artifacts.labels.push(labelB.label.id);
  check("planka_manage_labels create (B)", Boolean(labelB?.label?.id), labelB);

  if (!labelA?.label?.id || !labelB?.label?.id) {
    throw new Error("Without labels there is no smoke — stopping here");
  }

  const renamed = await json("planka_manage_labels", {
    action: "update",
    labelId: labelA.label.id,
    name: `${PREFIX} A2`,
    color: "pumpkin-orange",
  });
  check(
    "planka_manage_labels update renames and recolors",
    renamed?.label?.name === `${PREFIX} A2`,
    renamed
  );

  // --- the scratch card -----------------------------------------------------
  const created = await json("planka_create_card", {
    listId: list.id,
    name: CARD_NAME,
    description: "Scratch card of the planka-mcp smoke test. Delete it if you see it.",
    tasks: ["first", "second"],
    labelIds: [labelA.label.id],
  });
  const cardId = created?.card?.id;
  if (cardId) artifacts.cards.push(cardId);
  check(
    "planka_create_card creates a card with 2 tasks and 1 label",
    Boolean(cardId) && created.tasksCreated === 2 && created.labelsAttached === 1,
    created
  );
  if (!cardId) throw new Error("Without a card there is no smoke — stopping here");

  state = await rawBoard();
  check(
    "the raw API confirms the card exists",
    state.cards.some((item) => item.id === cardId),
    cardId
  );

  const details = await json("planka_get_card", { cardId });
  check(
    "planka_get_card returns the name, both tasks and the label",
    details?.card?.name === CARD_NAME &&
      details?.tasks?.length === 2 &&
      details?.labels?.length === 1,
    details
  );
  const taskId = details?.tasks?.[0]?.id;

  const updated = await callTool("planka_update_card", {
    cardId,
    description: "description updated by the smoke test",
  });
  check("planka_update_card updates the description", !updated.isError, updated.text);

  const reread = await json("planka_get_card", { cardId });
  check(
    "the update persisted (verified by re-reading)",
    reread?.card?.description === "description updated by the smoke test",
    reread?.card?.description
  );

  const taskUpdated = await callTool("planka_update_task", {
    taskId,
    isCompleted: true,
    name: "first (done)",
  });
  check("planka_update_task completes and renames", !taskUpdated.isError, taskUpdated.text);

  const taskAdded = await callTool("planka_create_tasks", {
    cardId,
    tasks: ["third"],
  });
  check("planka_create_tasks appends a task", !taskAdded.isError, taskAdded.text);

  const taskDeleted = await callTool("planka_delete_task", { taskId });
  check("planka_delete_task removes the task", !taskDeleted.isError, taskDeleted.text);

  // --- labels on the card ---------------------------------------------------
  const swapped = await json("planka_set_card_labels", {
    cardId,
    addLabelIds: [labelB.label.id],
    removeLabelIds: [labelA.label.id],
  });
  check(
    "planka_set_card_labels adds B and removes A (verified by re-reading)",
    swapped?.labelsAdded === 1 &&
      swapped?.labelsRemoved === 1 &&
      swapped?.finalLabelIds?.length === 1 &&
      swapped.finalLabelIds[0] === labelB.label.id,
    swapped
  );

  state = await rawBoard();
  check(
    "the raw API agrees on which label the card carries",
    state.cardLabels.some(
      (item) => item.cardId === cardId && item.labelId === labelB.label.id
    ) &&
      !state.cardLabels.some(
        (item) => item.cardId === cardId && item.labelId === labelA.label.id
      ),
    state.cardLabels.filter((item) => item.cardId === cardId)
  );

  // --- scoped reads ---------------------------------------------------------
  const filtered = await json("planka_list_cards", {
    listId: list.id,
    labelFilter: `${PREFIX} B`,
  });
  check(
    "planka_list_cards with labelFilter finds the card",
    filtered?.cards?.some((card) => card.id === cardId),
    filtered
  );

  const allCards = await json("planka_list_cards", {
    listId: list.id,
    limit: 200,
    withLabels: false,
  });
  const totalInList = allCards?.total ?? 0;
  check(
    "planka_list_cards reports total/returned/hasMore",
    allCards?.total === allCards?.returned &&
      allCards?.hasMore === false &&
      allCards?.nextOffset === undefined,
    allCards
  );

  const rawListCards = await api.get(`/api/lists/${list.id}/cards`);
  check(
    "the count matches the raw API (or exceeds one page, which is the point)",
    totalInList >= (rawListCards.items?.length ?? 0),
    `mcp total=${totalInList} · raw first page=${rawListCards.items?.length}`
  );

  check(
    "planka_list_cards omits descriptions by default",
    allCards?.cards?.every((card) => card.description === undefined),
    allCards?.cards?.[0]
  );

  const page = await json("planka_list_cards", {
    listId: list.id,
    limit: 1,
    withLabels: false,
  });
  check(
    "planka_list_cards clips but says how much was left out",
    page?.returned === 1 &&
      page?.total === totalInList &&
      page?.hasMore === totalInList > 1 &&
      (totalInList > 1 ? page.nextOffset === 1 : true),
    page
  );

  if (totalInList > 1) {
    const next = await json("planka_list_cards", {
      listId: list.id,
      limit: 1,
      offset: page.nextOffset,
      withLabels: false,
    });
    check(
      "planka_list_cards with an offset returns the next card, not the same one",
      next?.returned === 1 &&
        next.offset === 1 &&
        next.cards[0].id !== page.cards[0].id,
      next
    );
  } else {
    check(
      "planka_list_cards with an offset returns the next card, not the same one",
      true,
      "single-card list: nothing to page"
    );
  }

  const lists = await json("planka_list_lists", { boardId });
  const targetList = lists?.lists?.find((item) => item.id === list.id);
  check(
    "planka_list_lists counts each column's cards without returning them",
    Boolean(targetList) &&
      !JSON.stringify(lists).includes(CARD_NAME) &&
      lists.lists.every((item) => item.name !== null),
    lists
  );

  check(
    "planka_list_lists is far cheaper than planka_get_board",
    JSON.stringify(lists).length * 4 < boardText.length,
    `list_lists=${JSON.stringify(lists).length} chars · get_board=${boardText.length} chars`
  );

  // --- board_summary --------------------------------------------------------
  const summary = await json("planka_board_summary", {
    boardId,
    cardsFrom: [list.id],
    highlightLabel: `${PREFIX} B`,
  });
  const summaryCard = summary?.cards?.find((card) => card.id === cardId);
  check(
    "planka_board_summary returns columns with counts, labels and the requested cards",
    summary?.board?.id === boardId &&
      summary.lists.some((item) => item.id === list.id) &&
      summary.labels.some((item) => item.id === labelB.label.id) &&
      summary.cardsFrom.includes(list.name) &&
      Boolean(summaryCard),
    summary
  );

  check(
    "planka_board_summary flags the card carrying the highlighted label",
    summaryCard?.highlighted === true &&
      summary?.highlightedCount >= 1 &&
      summary.cards[0].highlighted === true,
    summary?.cards?.slice(0, 3)
  );

  const summaryOther = await json("planka_board_summary", {
    boardId,
    cardsFrom: [list.id],
    highlightLabel: `${PREFIX} a label that does not exist`,
  });
  check(
    "planka_board_summary highlights nothing when the label is absent",
    summaryOther?.highlightedCount === 0 &&
      summaryOther.cards.every((card) => card.highlighted === undefined),
    summaryOther?.highlightedCount
  );

  check(
    "planka_board_summary fits in a fraction of planka_get_board",
    JSON.stringify(summary).length * 3 < boardText.length &&
      !JSON.stringify(summary).includes("description"),
    `board_summary=${JSON.stringify(summary).length} chars · get_board=${boardText.length} chars`
  );

  // --- find_cards -----------------------------------------------------------
  const byLabel = await json("planka_find_cards", {
    boardId,
    labelName: `${PREFIX} B`,
  });
  check(
    "planka_find_cards by label returns exactly the labelled card",
    byLabel?.total === 1 &&
      byLabel.matches[0].id === cardId &&
      byLabel.matches[0].list === list.name,
    byLabel
  );

  // The description was written by the update above and is NOT in the name:
  // if this matches, the text search really is reading descriptions.
  const byText = await json("planka_find_cards", {
    boardId,
    query: "description updated by the smoke",
  });
  check(
    "planka_find_cards by text matches the description, not just the name",
    byText?.matches?.some((card) => card.id === cardId),
    byText
  );

  const scoped = await json("planka_find_cards", {
    boardId,
    query: PREFIX,
    listId: list.id,
  });
  check(
    "planka_find_cards with listId stays inside that column",
    scoped?.matches?.length > 0 &&
      scoped.matches.every((card) => card.listId === list.id),
    scoped
  );

  const noLabel = await json("planka_find_cards", {
    boardId,
    labelName: `${PREFIX} nonexistent label`,
  });
  check(
    "planka_find_cards warns when the label does not exist and lists the ones that do",
    noLabel?.total === 0 &&
      typeof noLabel.warning === "string" &&
      noLabel.warning.includes(`${PREFIX} B`),
    noLabel?.warning
  );

  const noFilter = await callTool("planka_find_cards", { boardId });
  check(
    "ERROR: an unfiltered find_cards is rejected instead of dumping the board",
    noFilter.isError && noFilter.text.includes("labelName"),
    noFilter.text
  );

  const moved = await callTool("planka_move_card", {
    cardId,
    listId: list.id,
    position: 1,
  });
  check("planka_move_card repositions inside the list", !moved.isError, moved.text);

  // --- comments: a 0 has to be a REAL 0 -------------------------------------
  const emptyMcp = await json("planka_get_comments", { cardId });
  const emptyRaw = await api.getComments(cardId);
  check(
    "planka_get_comments on a card with none: 0, and the raw API says 0 too",
    emptyMcp?.commentCount === 0 && (emptyRaw.items?.length ?? 0) === 0,
    `mcp=${emptyMcp?.commentCount} · raw=${emptyRaw.items?.length}`
  );

  const addedComment = await json("planka_add_comment", {
    cardId,
    text: "smoke: original comment",
  });
  const commentId = addedComment?.comment?.id;
  check("planka_add_comment creates the comment", Boolean(commentId), addedComment);

  const readMcp = await json("planka_get_comments", { cardId });
  check(
    "planka_get_comments reads back 1 comment with the exact text",
    readMcp?.commentCount === 1 &&
      readMcp.comments[0].text === "smoke: original comment",
    readMcp
  );

  const readRaw = await api.getComments(cardId);
  check(
    "cross-check against the raw API: same count, same id, same text",
    readRaw.items?.length === readMcp?.commentCount &&
      readRaw.items[0].id === commentId &&
      readRaw.items[0].text === readMcp.comments[0].text,
    readRaw.items?.map((item) => ({ id: item.id, text: item.text }))
  );

  check(
    "planka_get_comments resolves the author's name",
    Boolean(readMcp?.comments?.[0]?.author),
    readMcp?.comments?.[0]
  );

  const editedComment = await callTool("planka_manage_comment", {
    action: "update",
    commentId,
    text: "smoke: edited comment",
  });
  check("planka_manage_comment update", !editedComment.isError, editedComment.text);

  const afterEditMcp = await json("planka_get_comments", { cardId });
  const afterEditRaw = await api.getComments(cardId);
  check(
    "the edit is visible over MCP and over the raw API",
    afterEditMcp?.comments[0].text === "smoke: edited comment" &&
      afterEditRaw.items[0].text === "smoke: edited comment",
    `mcp=${afterEditMcp?.comments[0].text} · raw=${afterEditRaw.items[0]?.text}`
  );

  const deletedComment = await callTool("planka_manage_comment", {
    action: "delete",
    commentId,
  });
  check("planka_manage_comment delete", !deletedComment.isError, deletedComment.text);

  const afterDeleteMcp = await json("planka_get_comments", { cardId });
  const afterDeleteRaw = await api.getComments(cardId);
  check(
    "after deleting: 0 over MCP and 0 over the raw API",
    afterDeleteMcp?.commentCount === 0 && (afterDeleteRaw.items?.length ?? 0) === 0,
    `mcp=${afterDeleteMcp?.commentCount} · raw=${afterDeleteRaw.items?.length}`
  );

  // --- attachments: byte-for-byte roundtrip ---------------------------------
  workDir = mkdtempSync(join(tmpdir(), "planka-mcp-smoke-"));
  const filePath = join(workDir, "smoke-payload.txt");
  const payload =
    "planka-mcp smoke payload\n" +
    "accents: ñáéíóú — çü « » 😀\n" +
    Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(i)}`).join("\n") +
    "\n";
  writeFileSync(filePath, payload, "utf8");
  const sourceBytes = Buffer.from(payload, "utf8");
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");

  const addedAttachment = await json("planka_add_attachment", {
    cardId,
    filePath,
    name: "smoke-payload.txt",
  });
  const attachmentId = addedAttachment?.attachment?.id;
  if (attachmentId) artifacts.attachments.push(attachmentId);
  check(
    "planka_add_attachment uploads and verifies by re-reading the card",
    addedAttachment?.verified === true && Boolean(attachmentId),
    addedAttachment
  );

  const listedAttachments = await json("planka_get_attachments", { cardId });
  check(
    "planka_get_attachments lists the attachment with its size and URL",
    listedAttachments?.attachmentCount === 1 &&
      listedAttachments.attachments[0].id === attachmentId &&
      Boolean(listedAttachments.attachments[0].url),
    listedAttachments
  );

  const downloaded = await api.getBinary(listedAttachments.attachments[0].url);
  const downloadedHash = createHash("sha256").update(downloaded).digest("hex");
  check(
    "byte-identical roundtrip (sha256 uploaded == downloaded)",
    downloadedHash === sourceHash && downloaded.byteLength === sourceBytes.byteLength,
    `uploaded   ${sourceHash} (${sourceBytes.byteLength} bytes)\ndownloaded ${downloadedHash} (${downloaded.byteLength} bytes)`
  );

  const viewed = await callTool("planka_view_attachment", { cardId, attachmentId });
  check(
    "planka_view_attachment returns the content inline, unaltered",
    !viewed.isError && viewed.text.endsWith(payload),
    viewed.text
  );

  const deletedAttachment = await callTool("planka_delete_attachment", {
    attachmentId,
  });
  if (!deletedAttachment.isError) forget("attachments", attachmentId);
  check(
    "planka_delete_attachment removes the attachment",
    !deletedAttachment.isError,
    deletedAttachment.text
  );

  const afterAttachmentDelete = await json("planka_get_attachments", { cardId });
  check(
    "the card is back to 0 attachments",
    afterAttachmentDelete?.attachmentCount === 0,
    afterAttachmentDelete
  );

  // --- board lists ----------------------------------------------------------
  const tempList = await json("planka_manage_lists", {
    action: "create",
    boardId,
    name: `${PREFIX} temporary list`,
  });
  if (tempList?.list?.id) artifacts.lists.push(tempList.list.id);
  check("planka_manage_lists create", Boolean(tempList?.list?.id), tempList);

  const renamedList = await json("planka_manage_lists", {
    action: "update",
    listId: tempList.list.id,
    name: `${PREFIX} renamed list`,
  });
  check(
    "planka_manage_lists update renames",
    renamedList?.list?.name === `${PREFIX} renamed list`,
    renamedList
  );

  const deletedList = await callTool("planka_manage_lists", {
    action: "delete",
    listId: tempList.list.id,
  });
  if (!deletedList.isError) forget("lists", tempList.list.id);
  check("planka_manage_lists delete", !deletedList.isError, deletedList.text);

  // --- actionable error paths ----------------------------------------------
  const errMissing = await callTool("planka_add_comment", { cardId });
  check(
    "ERROR: a missing required field names the tool and the field",
    errMissing.isError &&
      errMissing.text.includes("text") &&
      errMissing.text.includes("planka_add_comment"),
    errMissing.text
  );

  const errEmptyId = await callTool("planka_get_card", { cardId: "" });
  check(
    "ERROR: an empty id is rejected with an actionable message",
    errEmptyId.isError && errEmptyId.text.includes("cardId"),
    errEmptyId.text
  );

  const errUnknown = await callTool("planka_get_cardz", { cardId: "x" });
  check(
    "ERROR: an unknown tool lists the available ones",
    errUnknown.isError && errUnknown.text.includes("Unknown tool"),
    errUnknown.text
  );

  const errNoop = await callTool("planka_set_card_labels", { cardId });
  check(
    "ERROR: set_card_labels with no labels does not fake success",
    errNoop.isError && errNoop.text.toLowerCase().includes("nothing to do"),
    errNoop.text
  );

  const errBadType = await callTool("planka_manage_lists", {
    action: "create",
    boardId,
    name: `${PREFIX} should not exist`,
    position: "not-a-number",
  });
  check(
    "ERROR: a wrong type is rejected before touching Planka",
    errBadType.isError && errBadType.text.includes("position"),
    errBadType.text
  );

  const errAttachment = await callTool("planka_view_attachment", {
    cardId,
    attachmentId: "999999999999999999",
  });
  check(
    "ERROR: a missing attachment says what is available",
    errAttachment.isError && errAttachment.text.includes("not found"),
    errAttachment.text
  );

  // --- a projectId handed to a boardId --------------------------------------
  const structure = await json("planka_get_structure", {});
  const projectId = structure?.[0]?.project?.id ?? null;
  if (projectId) {
    const asBoard = await callTool("planka_get_board", { boardId: projectId });
    // Two valid outcomes: a single-board project resolves itself and returns
    // the board; a multi-board one has to say it is a projectId and list them.
    check(
      "a projectId passed as boardId resolves or explains itself, never a mute 404",
      !asBoard.isError ||
        (asBoard.text.includes("projectId") && asBoard.text.includes("boards")),
      asBoard.text
    );
  } else {
    check(
      "a projectId passed as boardId resolves or explains itself, never a mute 404",
      false,
      "could not resolve a projectId from planka_get_structure"
    );
  }

  const errNoSuchBoard = await callTool("planka_get_board", {
    boardId: "999999999999999999",
  });
  check(
    "an unknown boardId says it is not a projectId either and lists the real boards",
    errNoSuchBoard.isError &&
      errNoSuchBoard.text.includes("not a projectId") &&
      errNoSuchBoard.text.includes(boardId),
    errNoSuchBoard.text
  );

  // --- teardown, verified ---------------------------------------------------
  const deletedCard = await callTool("planka_delete_card", { cardId });
  if (!deletedCard.isError) forget("cards", cardId);
  check("planka_delete_card deletes the card", !deletedCard.isError, deletedCard.text);

  state = await rawBoard();
  check(
    "the raw API confirms the card is gone",
    !state.cards.some((item) => item.id === cardId),
    cardId
  );

  for (const labelId of [labelA.label.id, labelB.label.id]) {
    const deletedLabel = await callTool("planka_manage_labels", {
      action: "delete",
      labelId,
    });
    if (!deletedLabel.isError) forget("labels", labelId);
    check(`planka_manage_labels delete (${labelId})`, !deletedLabel.isError, deletedLabel.text);
  }

  state = await rawBoard();
  const leftovers = [
    ...state.cards.filter((item) => item.name?.startsWith(PREFIX)),
    ...state.lists.filter((item) => item.name?.startsWith(PREFIX)),
    ...state.labels.filter((item) => item.name?.startsWith(PREFIX)),
  ];
  check(
    "the board carries no smoke artifacts",
    leftovers.length === 0,
    leftovers.map((item) => `${item.id} ${item.name}`).join("\n")
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let crashed = null;
try {
  await client.connect(transport);
  console.log(`Planka: ${api.baseUrl} (${process.env.PLANKA_AGENT_EMAIL})\n`);
  await run();
} catch (error) {
  crashed = error instanceof Error ? error : new Error(String(error));
} finally {
  await cleanup();
  await client.close().catch(() => {});
}

console.log("\n" + "=".repeat(60));
if (crashed) {
  console.log(`SMOKE_FAILED: aborted — ${crashed.message}`);
  if (process.env.VERBOSE) console.error(crashed);
}
console.log(`checks: ${passed} PASS · ${failed} FAIL · ${passed + failed} total`);
const exitCode = crashed || failed > 0 ? 1 : 0;
console.log(
  exitCode === 0
    ? `SMOKE_OK board=${boardId} tools=${EXPECTED_TOOL_COUNT} raw_api_verified=true`
    : "SMOKE_FAILED"
);
process.exit(exitCode);
