#!/usr/bin/env node

import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PlankaApi, boardEntities } from "../../scripts/lib/planka-api.mjs";

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
const marker = `planka-mcp-smoke-${Date.now()}`;
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

let cardId = null;
let temporaryLabelId = null;

function parseToolResult(name, result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (result.isError) throw new Error(`${name} failed: ${text || "unknown error"}`);
  if (!text) throw new Error(`${name} returned no text content`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} returned non-JSON content: ${text}`);
  }
}

async function call(name, args) {
  return parseToolResult(name, await client.callTool({ name, arguments: args }));
}

async function rawBoard() {
  return boardEntities(await api.getBoard(boardId));
}

async function cleanup() {
  if (cardId) {
    try {
      await api.deleteCard(cardId);
    } catch {
      // The tested delete path may already have removed it.
    }
  }
  if (temporaryLabelId) {
    try {
      await api.deleteLabel(temporaryLabelId);
    } catch {
      // Cleanup errors are reported by the final verification below.
    }
  }
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 15) {
    throw new Error(`Expected 15 MCP tools, got ${tools.tools.length}`);
  }

  const mcpBoard = await call("planka_get_board", { boardId });
  if (mcpBoard.board?.id !== boardId) {
    throw new Error("planka_get_board did not return the selected board");
  }

  let state = await rawBoard();
  const list = state.lists.find((item) => item.name && item.type !== "closed");
  if (!list) throw new Error("The board needs at least one active list");
  let label = state.labels[0];
  if (!label) {
    const response = await api.createLabel(
      boardId,
      `[setup test] ${marker}`,
      "morning-sky",
      65536
    );
    label = response.item;
    temporaryLabelId = label.id;
  }

  const created = await call("planka_create_card", {
    listId: list.id,
    name: `[setup test] ${marker}`,
    description: "Temporary card. The setup smoke test deletes it.",
  });
  cardId = created.card?.id;
  if (!cardId) throw new Error("planka_create_card returned no card id");

  await call("planka_set_card_labels", {
    cardId,
    labelIds: [label.id],
  });
  state = await rawBoard();
  if (!state.cardLabels.some((item) => item.cardId === cardId && item.labelId === label.id)) {
    throw new Error("MCP reported label success, but raw Planka state has no label");
  }

  await call("planka_set_card_labels", {
    cardId,
    removeLabelIds: [label.id],
  });
  state = await rawBoard();
  if (state.cardLabels.some((item) => item.cardId === cardId && item.labelId === label.id)) {
    throw new Error("MCP reported label removal, but raw Planka state still has it");
  }

  const commentText = `setup verification ${marker}`;
  await call("planka_add_comment", { cardId, text: commentText });
  const mcpComments = await call("planka_get_comments", { cardId });
  if (!mcpComments.comments?.some((item) => item.text === commentText)) {
    throw new Error("MCP did not re-read the comment it created");
  }
  const rawComments = await api.getComments(cardId);
  if (!rawComments?.items?.some((item) => item.text === commentText)) {
    throw new Error("Raw Planka API does not contain the comment MCP reported");
  }

  await call("planka_delete_card", { cardId });
  state = await rawBoard();
  if (state.cards.some((item) => item.id === cardId)) {
    throw new Error("MCP reported card deletion, but raw Planka still contains it");
  }
  cardId = null;

  if (temporaryLabelId) {
    await api.deleteLabel(temporaryLabelId);
    temporaryLabelId = null;
  }
  console.log(`SMOKE_OK board=${boardId} tools=15 raw_api_verified=true`);
} catch (error) {
  console.error(`SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  await client.close().catch(() => {});
}
