/**
 * Docker HEALTHCHECK. In HTTP mode it probes GET /healthz (which never
 * touches Planka); in stdio mode there is no port to probe and the process
 * being alive is the whole story, so it reports healthy.
 */
import { readFileSync } from "node:fs";

function httpRequested(): boolean {
  if (process.env.MCP_TRANSPORT?.trim().toLowerCase() === "http") return true;
  try {
    // `--http` passed as a container argument lives in PID 1's command line.
    return readFileSync("/proc/1/cmdline", "utf8").split("\0").includes("--http");
  } catch {
    return false;
  }
}

if (!httpRequested()) process.exit(0);

const host = process.env.HOST?.trim();
const target =
  !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
const port = process.env.PORT?.trim() || "3000";
const url = `http://${target.includes(":") ? `[${target}]` : target}:${port}/healthz`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
