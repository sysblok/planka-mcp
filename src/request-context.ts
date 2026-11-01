/**
 * Per-request credentials for the multi-user HTTP mode.
 *
 * In HTTP mode one process serves many Planka users at once: every MCP request
 * carries its caller's own API key, and everything that request does — every
 * Planka call, every cache lookup — must run as that caller and nobody else.
 * AsyncLocalStorage carries the key down the async call chain, so the
 * operations modules keep importing the one `plankaClient` and never see it.
 *
 * In stdio mode nothing is ever stored here and the client falls back to the
 * credentials in the environment, exactly as before.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface RequestContext {
  /** The caller's Planka API key. Never log it, never return it. */
  readonly apiKey: string;
  /**
   * A SHA-256 fingerprint of the key: safe to use as a cache partition, and
   * the only form of the key that may live longer than the request.
   */
  readonly keyId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Runs `fn` — and everything it awaits — as the owner of `apiKey`. */
export function runWithApiKey<T>(apiKey: string, fn: () => T): T {
  return storage.run({ apiKey, keyId: fingerprintKey(apiKey) }, fn);
}

/** The current request's credentials, or undefined outside of one (stdio). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The partition a per-user cache must file the current request under: the key
 * fingerprint in HTTP mode, a single shared slot in stdio mode (one process,
 * one user — the behaviour the caches always had).
 */
export function cacheScope(): string {
  return getRequestContext()?.keyId ?? "process";
}

const REDACTED = "[redacted]";

/**
 * Replaces every occurrence of each secret in `text`. Secrets shorter than 8
 * characters are skipped: no real Planka key is that short, and scrubbing a
 * two-letter test value would mangle unrelated text.
 */
export function redactSecrets(
  text: string,
  secrets: ReadonlyArray<string | undefined>
): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
