#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { bootstrapBoard } from "./bootstrap-board.mjs";
import { PlankaApi, PlankaApiError, boardEntities } from "./lib/planka-api.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = resolve(root, "dist/index.js");
const credentials = {
  baseUrl: process.env.PLANKA_BASE_URL,
  email: process.env.PLANKA_AGENT_EMAIL,
  password: process.env.PLANKA_AGENT_PASSWORD,
};
const rl = createInterface({ input, output });

async function ask(question, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function choose(question, items) {
  console.log(`\n${question}`);
  items.forEach((item, index) => console.log(`  ${index + 1}) ${item.label}`));
  while (true) {
    const raw = await ask("Choose", "1");
    const index = Number(raw) - 1;
    if (Number.isInteger(index) && items[index]) return items[index].value;
    console.log(`Enter a number from 1 to ${items.length}.`);
  }
}

async function writePrivateLauncher() {
  const configDir = resolve(
    process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"),
    "planka-mcp"
  );
  const configPath = resolve(configDir, "config.json");
  const binDir = resolve(homedir(), ".local", "bin");
  const launcherPath = resolve(binDir, "planka-mcp");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        baseUrl: credentials.baseUrl.replace(/\/+$/, ""),
        email: credentials.email,
        password: credentials.password,
        serverEntry,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  await chmod(configPath, 0o600);

  const launcher = `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const config = JSON.parse(await readFile(${JSON.stringify(configPath)}, "utf8"));
process.env.PLANKA_BASE_URL = config.baseUrl;
process.env.PLANKA_AGENT_EMAIL = config.email;
process.env.PLANKA_AGENT_PASSWORD = config.password;
await import(pathToFileURL(config.serverEntry).href);
`;
  await writeFile(launcherPath, launcher, { mode: 0o700 });
  await chmod(launcherPath, 0o700);
  return { configPath, launcherPath };
}

async function configureClaude(launcherPath) {
  console.log("\nChoose how Claude Code should load the server:");
  console.log("  CLI/user scope: private to this machine and available in every project.");
  console.log("  .mcp.json: committed with a project so every teammate gets the same server entry; credentials stay outside Git.");
  const mode = await choose("Configuration method", [
    { label: "claude mcp add (easiest)", value: "cli" },
    { label: ".mcp.json in a project (team-friendly)", value: "project" },
  ]);

  if (mode === "cli") {
    const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (probe.error?.code === "ENOENT") {
      throw new Error(
        "Claude Code is not installed or is not on PATH. Install it, then rerun setup."
      );
    }
    spawnSync("claude", ["mcp", "remove", "planka", "--scope", "user"], {
      stdio: "ignore",
    });
    const added = spawnSync(
      "claude",
      [
        "mcp",
        "add",
        "planka",
        "--scope",
        "user",
        "--transport",
        "stdio",
        "--",
        launcherPath,
      ],
      { encoding: "utf8" }
    );
    if (added.status !== 0) {
      throw new Error(
        `claude mcp add failed: ${(added.stderr || added.stdout || "unknown error").trim()}`
      );
    }
    console.log("Claude Code user configuration updated.");
    return;
  }

  const projectDir = resolve(await ask("Project directory", process.cwd()));
  await access(projectDir, constants.R_OK | constants.W_OK);
  const mcpPath = resolve(projectDir, ".mcp.json");
  let document = { mcpServers: {} };
  try {
    document = JSON.parse(await readFile(mcpPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Cannot parse ${mcpPath}: ${error.message}`);
    }
  }
  if (!document.mcpServers || typeof document.mcpServers !== "object") {
    document.mcpServers = {};
  }
  document.mcpServers.planka = {
    type: "stdio",
    command: "${HOME}/.local/bin/planka-mcp",
    args: [],
  };
  await writeFile(mcpPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${mcpPath}`);
  console.log("Claude Code will ask you to trust this project-scoped server on first use.");
}

async function selectBoard(api) {
  const projectsResponse = await api.getProjects();
  const projects = Array.isArray(projectsResponse?.items)
    ? projectsResponse.items
    : [];
  const boards = Array.isArray(projectsResponse?.included?.boards)
    ? projectsResponse.included.boards
    : [];
  if (!projects.length) {
    throw new Error("The agent user cannot see any Planka projects.");
  }

  const boardOptions = boards.map((board) => {
    const project = projects.find((item) => item.id === board.projectId);
    return {
      label: `${project?.name || "Unknown project"} / ${board.name}`,
      value: { kind: "existing", board },
    };
  });
  boardOptions.push({
    label: "Create a new board with the optional workflow template",
    value: { kind: "create" },
  });
  const selection = await choose("Boards visible to the agent user", boardOptions);

  if (selection.kind === "create") {
    const projectId = await choose(
      "Project for the new board (the agent user must be a project manager)",
      projects.map((project) => ({ label: project.name, value: project.id }))
    );
    const boardName = await ask("New board name", "Agent Work");
    const result = await bootstrapBoard(api, { projectId, boardName });
    console.log(
      `Created ${result.boardName} with ${result.listCount} lists and ${result.labelCount} labels.`
    );
    return result.boardId;
  }

  const boardId = selection.board.id;
  const state = boardEntities(await api.getBoard(boardId));
  const usableLists = state.lists.filter((item) => item.name && item.type !== "closed");
  if (!usableLists.length) {
    console.log("The selected board has no active list, so setup will install the workflow template.");
    await bootstrapBoard(api, { boardId });
  }
  return boardId;
}

async function runSmoke(boardId) {
  console.log("\nRunning the real MCP smoke test (the temporary card is deleted)...");
  const result = spawnSync(
    process.execPath,
    [resolve(root, "tests/smoke/planka-smoke.mjs")],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        PLANKA_SMOKE_BOARD_ID: boardId,
        PLANKA_MCP_ENTRY: serverEntry,
      },
    }
  );
  if (result.status !== 0) {
    throw new Error("The real smoke test failed. The MCP configuration was written, but setup is not verified.");
  }
}

async function main() {
  try {
    console.log("\nValidating credentials against POST /api/access-tokens...");
    const api = await PlankaApi.fromCredentials(credentials);
    console.log("Credentials valid. JSON API response received.");
    const boardId = await selectBoard(api);
    const { launcherPath } = await writePrivateLauncher();
    await configureClaude(launcherPath);
    await runSmoke(boardId);
    console.log("\nSetup complete.");
    console.log('Reiniciá Claude Code y pedile “mostrame mi board de Planka”.');
    console.log('Restart Claude Code, approve the server if prompted, and ask: “show me my Planka board”.');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const prefix = error instanceof PlankaApiError ? "Planka API error" : "Setup error";
  console.error(`\n${prefix}: ${error.message}`);
  process.exit(1);
});
