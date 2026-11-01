#!/usr/bin/env node
/**
 * PLANKA MCP Server
 *
 * A Model Context Protocol server for PLANKA kanban boards.
 * Provides tools for managing projects, boards, cards, tasks, labels, and comments.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { resolveTransport } from "./transport-mode.js";

/** stdio: one server for the life of the process, as it has always been. */
async function mainStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup (to stderr so it doesn't interfere with MCP protocol)
  console.error("PLANKA MCP server started");
}

/** Multi-user Streamable HTTP, behind a gateway. Loaded only when asked for. */
async function mainHttp() {
  const { startHttpServer, httpOptionsFromEnv } = await import("./http.js");
  const options = httpOptionsFromEnv();
  const server = await startHttpServer(options);
  console.error(
    `PLANKA MCP server listening on http://${options.host}:${options.port}/mcp (multi-user HTTP mode)`
  );
  const shutdown = () => {
    server.close(() => process.exit(0));
    // In-flight requests get a grace period, then the process goes regardless.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/**
 * The binary has two jobs. Started by an MCP client it speaks stdio and must
 * never print to stdout; run by a human as `planka-mcp init` it configures that
 * client instead. The subcommand is dispatched before anything MCP is loaded so
 * a missing PLANKA_BASE_URL cannot break the setup command that exists to fix it.
 */
const subcommand = process.argv[2];

if (subcommand === "init") {
  const { runInit } = await import("./cli/init.js");
  const { createInterface } = await import("node:readline/promises");
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  try {
    const code = await runInit(process.argv.slice(3), {
      // Secrets must not echo: readline has no password mode, so its output
      // writer is muted for the duration of the answer (the same trick the
      // shell installer got from `read -s`).
      ask: rl
        ? async (question: string, secret = false) => {
            if (!secret) return (await rl.question(`${question}: `)).trim();
            const iface = rl as unknown as {
              _writeToOutput: (text: string) => void;
            };
            const previous = iface._writeToOutput;
            iface._writeToOutput = (text: string) => {
              if (text.includes(question)) previous.call(iface, text);
            };
            try {
              const answer = await rl.question(`${question}: `);
              process.stdout.write("\n");
              return answer.trim();
            } finally {
              iface._writeToOutput = previous;
            }
          }
        : undefined,
    });
    process.exitCode = code;
  } catch (error) {
    console.error(`init failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    rl?.close();
  }
} else {
  // Run the server
  const run = async () =>
    resolveTransport() === "http" ? mainHttp() : mainStdio();
  run().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
