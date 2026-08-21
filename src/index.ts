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
import { getToolDefinitions, getTool } from "./tools/index.js";
import { PlankaError, PlankaConfigError } from "./errors.js";
import { SERVER_NAME, SERVER_VERSION } from "./identity.generated.js";

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
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${name}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args || {});
      return result;
    } catch (error) {
      // Handle configuration errors specifically
      if (error instanceof PlankaConfigError) {
        return {
          content: [
            {
              type: "text",
              text: `Configuration error: ${error.message}\n\nRequired environment variables:\n- PLANKA_BASE_URL\n- PLANKA_AGENT_EMAIL\n- PLANKA_AGENT_PASSWORD`,
            },
          ],
          isError: true,
        };
      }

      // Handle other PLANKA errors
      if (error instanceof PlankaError) {
        return {
          content: [
            {
              type: "text",
              text: `PLANKA error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      // Log unexpected errors and return generic message
      console.error(`Error in tool ${name}:`, error);
      return {
        content: [
          {
            type: "text",
            text: `Unexpected error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
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
