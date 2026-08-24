/**
 * Tool registry for PLANKA MCP server.
 */
import { navigationTools } from "./navigation.js";
import { cardTools } from "./cards.js";
import { taskTools } from "./tasks.js";
import { labelTools } from "./labels.js";
import { commentTools } from "./comments.js";
import { listTools } from "./lists.js";
import { attachmentTools } from "./attachments.js";
import { queryTools } from "./queries.js";

/**
 * All registered tools.
 */
export const allTools = [
  ...navigationTools,
  ...queryTools,
  ...cardTools,
  ...taskTools,
  ...labelTools,
  ...commentTools,
  ...listTools,
  ...attachmentTools,
];

/**
 * Content blocks a tool may return.
 * "image" lets the model actually SEE an attached screenshot (base64).
 */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Tool type definition.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: unknown) => Promise<{
    content: ToolContent[];
    isError?: boolean;
  }>;
}

/**
 * Get a tool by name.
 */
export function getTool(name: string): Tool | undefined {
  return allTools.find((tool) => tool.name === name) as Tool | undefined;
}

/**
 * Required inputSchema fields that never arrived.
 *
 * The inputSchema is JSON Schema, not Zod: this only checks presence, which is
 * what stops a missing `tasks` from blowing up inside the handler as "Cannot
 * read properties of undefined (reading 'map')".
 */
export function findMissingRequiredArgs(tool: Tool, args: unknown): string[] {
  const required = tool.inputSchema.required ?? [];
  const received =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return required.filter(
    (field) => received[field] === undefined || received[field] === null
  );
}

/**
 * Get all tool definitions (for MCP listTools).
 */
export function getToolDefinitions() {
  return allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

// Re-export individual tool groups
export { navigationTools } from "./navigation.js";
export { cardTools } from "./cards.js";
export { taskTools } from "./tasks.js";
export { labelTools } from "./labels.js";
export { commentTools } from "./comments.js";
export { listTools } from "./lists.js";
export { attachmentTools } from "./attachments.js";
export { queryTools } from "./queries.js";
