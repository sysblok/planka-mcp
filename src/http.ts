/**
 * Multi-user Streamable HTTP mode.
 *
 * Meant to run behind a gateway (LiteLLM) on a private network. Every request
 * carries its caller's Planka API key in `X-Api-Key`; the request runs — every
 * Planka call, every cache lookup — as that caller and nobody else. Stateless:
 * a fresh MCP server and transport per request, no session ids, nothing kept
 * between requests except caches partitioned by a hash of the key.
 *
 * This server trusts whoever can reach it to present only their own key. It
 * does no authentication of its own beyond forwarding the key to Planka, so it
 * must never be exposed outside the gateway's network.
 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { plankaClient } from "./client.js";
import { redactSecrets, runWithApiKey } from "./request-context.js";
import { createMcpServer } from "./server.js";

export const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpOptions {
  host: string;
  port: number;
}

/** HOST / PORT from the environment, with the documented defaults. */
export function httpOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): HttpOptions {
  const host = env.HOST?.trim() || "0.0.0.0";
  const rawPort = env.PORT?.trim() || "3000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort} (expected 1-65535)`);
  }
  return { host, port };
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

/** A JSON-RPC error envelope without an id: the request was never parsed. */
function rpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>
): void {
  sendJson(
    res,
    status,
    { jsonrpc: "2.0", error: { code, message }, id: null },
    headers
  );
}

/** The request's API key, or undefined. Node lowercases header names. */
export function apiKeyFrom(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-api-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const key = value?.trim();
  return key ? key : undefined;
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      rpcError(res, 413, -32600, `Request body exceeds ${MAX_BODY_BYTES} bytes`, {
        Connection: "close",
      });
      return;
    }
    throw error;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    rpcError(res, 400, -32700, "Parse error: the body is not valid JSON");
    return;
  }

  // Everything below — the SDK dispatch, every tool handler, every Planka
  // call it makes — runs inside this caller's async context.
  await runWithApiKey(apiKey, async () => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
}

/** The request listener, exported for tests. */
export function createRequestListener() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let apiKey: string | undefined;
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      if (path === "/healthz") {
        if (req.method === "GET" || req.method === "HEAD") {
          sendJson(res, 200, { status: "ok" });
        } else {
          sendJson(res, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
        }
        return;
      }

      if (path !== "/mcp") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      // Stateless: no SSE stream to open (GET) and no session to end
      // (DELETE). The MCP spec asks for 405 here, and the SDK client treats a
      // 405 on GET as "no stream" — a 404 would read as an expired session.
      if (req.method !== "POST") {
        rpcError(res, 405, -32000, "Method not allowed: this server is stateless, use POST", {
          Allow: "POST",
        });
        return;
      }

      // Before the body is read and before any MCP code runs.
      apiKey = apiKeyFrom(req);
      if (!apiKey) {
        req.resume();
        rpcError(res, 401, -32001, "Unauthorized: missing X-Api-Key header");
        return;
      }

      await handleMcp(req, res, apiKey);
    } catch (error) {
      // Never the request or its headers: only what went wrong, scrubbed.
      console.error(
        redactSecrets(
          `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
          [apiKey]
        )
      );
      rpcError(res, 500, -32603, "Internal server error");
    }
  };
}

/**
 * Validates the environment (no shared credential, a base URL) and starts
 * listening. Throws before binding when the configuration is unsafe.
 */
export async function startHttpServer(
  options: HttpOptions = httpOptionsFromEnv()
): Promise<HttpServer> {
  plankaClient.useRequestScopedKeys();

  const server = createServer(createRequestListener());
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
