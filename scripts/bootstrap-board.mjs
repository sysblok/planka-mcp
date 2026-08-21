#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  PlankaApi,
  PlankaApiError,
  boardEntities,
} from "./lib/planka-api.mjs";
import {
  WORKFLOW_LABELS,
  WORKFLOW_LISTS,
  nextPosition,
} from "./lib/workflow-template.mjs";

function parseArgs(argv) {
  const args = { force: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") args.force = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--board-id") args.boardId = argv[++index];
    else if (arg === "--project-id") args.projectId = argv[++index];
    else if (arg === "--board-name") args.boardName = argv[++index];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/bootstrap-board.mjs --board-id <id>
  node scripts/bootstrap-board.mjs --project-id <id> --board-name "Agent Work"

Environment:
  PLANKA_BASE_URL, PLANKA_AGENT_EMAIL, PLANKA_AGENT_PASSWORD

Options:
  --force   Add the template even when the board already has unrelated content
  --json    Print the result as JSON`;
}

export async function bootstrapBoard(
  api,
  { boardId, projectId, boardName = "Agent Work", force = false } = {}
) {
  let createdBoard = false;
  if (!boardId) {
    if (!projectId) {
      throw new Error("Pass either boardId or projectId");
    }
    const created = await api.createBoard(projectId, boardName);
    boardId = created?.item?.id;
    if (!boardId) throw new Error("Planka did not return the new board id");
    createdBoard = true;
  }

  let state = boardEntities(await api.getBoard(boardId));
  const templateListNames = new Set(WORKFLOW_LISTS.map((item) => item.name));
  const matchingLists = state.lists.filter((item) =>
    templateListNames.has(item.name)
  );
  const unrelatedLists = state.lists.filter(
    (item) => item.name && !templateListNames.has(item.name)
  );

  if (
    !force &&
    matchingLists.length === 0 &&
    (unrelatedLists.length > 0 || state.cards.length > 0)
  ) {
    throw new Error(
      "This board is not empty and does not look bootstrapped. Use --force only if you intentionally want to add the workflow alongside existing content."
    );
  }

  const createdLists = [];
  const existingListNames = new Set(state.lists.map((item) => item.name));
  for (const [index, definition] of WORKFLOW_LISTS.entries()) {
    if (existingListNames.has(definition.name)) continue;
    const response = await api.createList(
      boardId,
      definition.name,
      nextPosition(index),
      definition.type
    );
    createdLists.push(response.item);
  }

  state = boardEntities(await api.getBoard(boardId));
  const createdLabels = [];
  const existingLabelNames = new Set(state.labels.map((item) => item.name));
  for (const [index, definition] of WORKFLOW_LABELS.entries()) {
    if (existingLabelNames.has(definition.name)) continue;
    const response = await api.createLabel(
      boardId,
      definition.name,
      definition.color,
      nextPosition(index)
    );
    createdLabels.push(response.item);
  }

  const verified = boardEntities(await api.getBoard(boardId));
  const missingLists = WORKFLOW_LISTS.filter(
    (definition) =>
      !verified.lists.some(
        (item) =>
          item.name === definition.name &&
          (!item.type || item.type === definition.type)
      )
  );
  const missingLabels = WORKFLOW_LABELS.filter(
    (definition) =>
      !verified.labels.some((item) => item.name === definition.name)
  );
  if (missingLists.length || missingLabels.length) {
    throw new Error(
      `Bootstrap verification failed. Missing lists: ${missingLists.map((item) => item.name).join(", ") || "none"}; missing labels: ${missingLabels.map((item) => item.name).join(", ") || "none"}`
    );
  }

  return {
    boardId,
    boardName: verified.board?.name || boardName,
    createdBoard,
    createdLists: createdLists.map((item) => item.id),
    createdLabels: createdLabels.map((item) => item.id),
    listCount: WORKFLOW_LISTS.length,
    labelCount: WORKFLOW_LABELS.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const api = await PlankaApi.fromCredentials({
    baseUrl: process.env.PLANKA_BASE_URL,
    email: process.env.PLANKA_AGENT_EMAIL,
    password: process.env.PLANKA_AGENT_PASSWORD,
  });
  const result = await bootstrapBoard(api, args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Workflow ready on board: ${result.boardName} (${result.boardId})`);
    console.log(`Created ${result.createdLists.length} list(s) and ${result.createdLabels.length} label(s).`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const prefix = error instanceof PlankaApiError ? "Planka API error" : "Error";
    console.error(`${prefix}: ${error.message}`);
    process.exit(1);
  });
}
