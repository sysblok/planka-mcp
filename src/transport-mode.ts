/**
 * Which transport the server speaks. stdio unless asked otherwise, so every
 * existing client configuration keeps working unchanged.
 */
export type TransportMode = "stdio" | "http";

export function resolveTransport(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): TransportMode {
  if (argv.includes("--http")) return "http";
  const value = env.MCP_TRANSPORT?.trim().toLowerCase();
  if (!value || value === "stdio") return "stdio";
  if (value === "http") return "http";
  throw new Error(
    `Invalid MCP_TRANSPORT: ${env.MCP_TRANSPORT} (expected "stdio" or "http")`
  );
}
