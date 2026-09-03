/**
 * The try/catch every tool handler repeats: a PlankaError becomes a tool error
 * the model can read, anything else keeps bubbling up as a bug.
 */
import { PlankaError } from "../errors.js";

export interface ToolReply {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function guarded<T extends ToolReply>(
  run: () => Promise<T>
): Promise<T | ToolReply> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PlankaError) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error.message}` }],
        isError: true as const,
      };
    }
    throw error;
  }
}
