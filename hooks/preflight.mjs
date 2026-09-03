#!/usr/bin/env node
/**
 * SessionStart preflight for the Planka plugin.
 *
 * Cheap on purpose: it answers "is this server going to be able to start?"
 * without touching the network and without spawning the server, so it never
 * adds latency to a session. It checks the two things that actually break the
 * install — a Node too old for the package, and missing/contradictory
 * credentials — and stays silent when everything is in place.
 *
 * Set PLANKA_MCP_PREFLIGHT=full to also spawn the server binary and wait for
 * its stdio banner (adds an npx download on a cold cache; opt-in only).
 *
 * It NEVER exits non-zero: a broken preflight must not block a session.
 */
import { spawn } from "node:child_process";

const option = (key) => {
  const raw =
    process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] ??
    process.env[key.toUpperCase()];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || undefined;
};

const notes = [];

const major = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(major) && major < 18) {
  notes.push(
    `Node ${process.versions.node} is too old for @omnicoreos/planka-mcp (needs >= 18).`
  );
}

const baseUrl = option("PLANKA_BASE_URL");
const apiKey = option("PLANKA_API_KEY");
const email = option("PLANKA_AGENT_EMAIL");
const password = option("PLANKA_AGENT_PASSWORD");

if (!baseUrl) {
  notes.push(
    "PLANKA_BASE_URL is not configured: run /plugin and set the plugin's Planka base URL, or export PLANKA_BASE_URL."
  );
} else if (baseUrl.startsWith("http://")) {
  notes.push(
    `PLANKA_BASE_URL is http:// (${baseUrl}). A redirect to https:// drops POST bodies — configure the final https:// URL.`
  );
}

if (!apiKey && !(email && password)) {
  notes.push(
    "No Planka credentials: set the plugin's API key (recommended), or export PLANKA_AGENT_EMAIL + PLANKA_AGENT_PASSWORD."
  );
} else if (apiKey && (email || password)) {
  notes.push(
    "Both PLANKA_API_KEY and email/password are set. The server refuses that combination — keep the API key and unset the pair."
  );
}

async function spawnCheck() {
  return new Promise((resolve) => {
    const child = spawn(
      process.env.PLANKA_MCP_COMMAND || "npx",
      process.env.PLANKA_MCP_COMMAND ? [] : ["-y", "@omnicoreos/planka-mcp"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve("timed out before printing its startup banner");
    }, 20000);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("PLANKA MCP server started")) {
        clearTimeout(timer);
        child.kill();
        resolve(null);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(`could not be spawned: ${error.message}`);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(stderr.includes("PLANKA MCP server started") ? null : "exited without starting");
    });
  });
}

if (process.env.PLANKA_MCP_PREFLIGHT === "full") {
  const failure = await spawnCheck();
  if (failure) notes.push(`The Planka MCP server ${failure}.`);
}

if (notes.length > 0) {
  console.log(
    `Planka MCP preflight found ${notes.length} problem(s):\n- ${notes.join("\n- ")}`
  );
}
