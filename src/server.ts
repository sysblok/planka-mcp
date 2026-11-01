/**
 * The MCP server definition shared by the stdio and HTTP transports.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getToolDefinitions,
  getTool,
  allTools,
  effectiveInputSchema,
  findMissingRequiredArgs,
} from "./tools/index.js";
import {
  PlankaError,
  PlankaConfigError,
  PlankaInputError,
  formatInputError,
  formatMissingArgsError,
  formatResponseShapeError,
  isZodError,
} from "./errors.js";
import { SERVER_NAME, SERVER_VERSION } from "./identity.generated.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { listResources, readResource } from "./resources.js";
import { getPrompt, listPrompts } from "./prompts.js";

/** Standard error response back to the model. */
function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

import { plankaClient } from "./client.js";
import { redactSecrets } from "./request-context.js";

/**
 * Scrubs every credential the client could have sent out of a tool result.
 * Planka error bodies and odd responses can echo a request back; the caller's
 * key must not reach the model, the gateway's logs or another tool call.
 */
function redactResult<T>(result: T): T {
  const secrets = plankaClient.secrets();
  if (secrets.length === 0) return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  return {
    ...result,
    content: content.map((item) =>
      item && typeof item === "object" && typeof item.text === "string"
        ? { ...item, text: redactSecrets(item.text, secrets) }
        : item
    ),
  };
}

/**
 * One fully wired MCP server. stdio builds one for the life of the process;
 * HTTP mode builds a fresh one per request, so nothing survives between
 * callers.
 */
export function createMcpServer(): Server {
  // Create the MCP server
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        // Both are read-only catalogues that never change while the process
        // lives, so neither declares listChanged.
        resources: {},
        prompts: {},
      },
      // Sent back in the initialize handshake. Claude Code puts it in the system
      // prompt, Codex reads it alongside the tool list.
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Handler for listing available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: getToolDefinitions(),
    };
  });

  // The guides that ship in the tarball, served on demand. Cost is zero until
  // a client actually reads one, which is why they hold what does not fit in
  // `instructions`.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResource(request.params.uri)
  );

  // Slash-command shaped entry points (Claude Code: /mcp__planka__…).
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: listPrompts(),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getPrompt(request.params.name, request.params.arguments ?? {})
  );

  // Handler for tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    redactResult(await callTool(request.params.name, request.params.arguments))
  );

  return server;
}

async function callTool(
  name: string,
  args: Record<string, unknown> | undefined
) {
  const tool = getTool(name);
  if (!tool) {
    return errorResult(
      `Unknown tool: ${name}. Available tools: ${allTools
        .map((t) => t.name)
        .join(", ")}`
    );
  }

  // Presence check before entering the handler: a missing required field has
  // to name the tool and the field, not die somewhere inside.
  const schema = effectiveInputSchema(tool);
  const missing = findMissingRequiredArgs(tool, args);
  if (missing.length > 0) {
    return errorResult(formatMissingArgsError(name, missing, args, schema));
  }

  try {
    const result = await tool.handler(args || {});
    return result;
  } catch (error) {
    // INPUT validation: name the tool, the field and what arrived.
    if (error instanceof PlankaInputError) {
      return errorResult(formatInputError(name, error, schema));
    }

    // A loose ZodError means Planka's RESPONSE did not match the schema.
    // Name it separately so the model does not assume it got the args wrong.
    if (isZodError(error)) {
      return errorResult(formatResponseShapeError(name, error));
    }

    // Handle configuration errors specifically
    if (error instanceof PlankaConfigError) {
      return errorResult(
        `Configuration error: ${error.message}\n\nRequired: PLANKA_BASE_URL, plus EITHER PLANKA_API_KEY (recommended) OR PLANKA_AGENT_EMAIL + PLANKA_AGENT_PASSWORD.`
      );
    }

    // Handle other PLANKA errors
    if (error instanceof PlankaError) {
      return errorResult(`PLANKA error: ${error.message}`);
    }

    // Log unexpected errors and return generic message
    // Logged as text, scrubbed: the raw error object may carry request data.
    console.error(
      redactSecrets(
        `Error in tool ${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        plankaClient.secrets()
      )
    );
    return errorResult(
      `Unexpected error while running ${name}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
