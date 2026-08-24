#!/usr/bin/env node
/**
 * PLANKA MCP Server
 *
 * A Model Context Protocol server for PLANKA kanban boards.
 * Provides tools for managing projects, boards, cards, tasks, labels, and comments.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getToolDefinitions,
  getTool,
  allTools,
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

/** Standard error response back to the model. */
function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/**
 * Main entry point.
 */
async function main() {
  // Create the MCP server
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handler for listing available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: getToolDefinitions(),
    };
  });

  // Handler for tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

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
    const missing = findMissingRequiredArgs(tool, args);
    if (missing.length > 0) {
      return errorResult(
        formatMissingArgsError(name, missing, args, tool.inputSchema)
      );
    }

    try {
      const result = await tool.handler(args || {});
      return result;
    } catch (error) {
      // INPUT validation: name the tool, the field and what arrived.
      if (error instanceof PlankaInputError) {
        return errorResult(formatInputError(name, error, tool.inputSchema));
      }

      // A loose ZodError means Planka's RESPONSE did not match the schema.
      // Name it separately so the model does not assume it got the args wrong.
      if (isZodError(error)) {
        return errorResult(formatResponseShapeError(name, error));
      }

      // Handle configuration errors specifically
      if (error instanceof PlankaConfigError) {
        return errorResult(
          `Configuration error: ${error.message}\n\nRequired environment variables:\n- PLANKA_BASE_URL\n- PLANKA_AGENT_EMAIL\n- PLANKA_AGENT_PASSWORD`
        );
      }

      // Handle other PLANKA errors
      if (error instanceof PlankaError) {
        return errorResult(`PLANKA error: ${error.message}`);
      }

      // Log unexpected errors and return generic message
      console.error(`Error in tool ${name}:`, error);
      return errorResult(
        `Unexpected error while running ${name}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup (to stderr so it doesn't interfere with MCP protocol)
  console.error("PLANKA MCP server started");
}

// Run the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
