/**
 * HTTP client for PLANKA API with automatic authentication.
 */
import {
  PlankaAuthError,
  PlankaConfigError,
  PlankaNetworkError,
  createPlankaError,
} from "./errors.js";
import { AuthResponse } from "./schemas/responses.js";

export interface ClientConfig {
  baseUrl: string;
  /**
   * Planka API key (`X-Api-Key`). When present there is no login and no token
   * refresh: the key is sent on every request, including binary downloads.
   */
  apiKey?: string;
  email?: string;
  password?: string;
}

export interface RequestOptions {
  token?: string;
  /**
   * Planka API key. Mutually exclusive with `token` by design: Planka reads
   * `Authorization: Bearer` first and ignores `x-api-key` when both arrive
   * (`server/api/hooks/current-user/index.js`).
   */
  apiKey?: string;
  body?: unknown;
  /**
   * Multipart body (attachment uploads). Content-Type is left unset on
   * purpose: fetch generates it together with the boundary.
   */
  form?: FormData;
  /**
   * Also send the token as an `accessToken` cookie. Planka 2.0 serves
   * attachment downloads with either, and different deployments disagree on
   * which one they honour.
   */
  cookieToken?: boolean;
  signal?: AbortSignal;
}

export function createRequestInit(
  method: string,
  options: RequestOptions = {}
): RequestInit {
  const headers: Record<string, string> = {};
  if (options.apiKey) {
    // Never together with Authorization: Planka would ignore the key.
    headers["X-Api-Key"] = options.apiKey;
  } else if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
    if (options.cookieToken) {
      headers.Cookie = `accessToken=${options.token}`;
    }
  }
  if (options.form === undefined && options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return {
    method,
    headers,
    body:
      options.form ??
      (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    signal: options.signal,
  };
}

/**
 * Validates and returns the configuration from environment variables.
 */
export function getConfig(
  env: NodeJS.ProcessEnv = process.env
): ClientConfig {
  const baseUrl = env.PLANKA_BASE_URL;
  const apiKey = env.PLANKA_API_KEY?.trim() || undefined;
  const email = env.PLANKA_AGENT_EMAIL?.trim() || undefined;
  const password = env.PLANKA_AGENT_PASSWORD;

  if (!baseUrl) {
    throw new PlankaConfigError(
      "Missing required environment variables: PLANKA_BASE_URL"
    );
  }

  // API key XOR password login. Sending both is a configuration mistake worth
  // naming: Planka would silently use only one of them.
  if (apiKey && (email || password)) {
    throw new PlankaConfigError(
      "Conflicting Planka credentials: PLANKA_API_KEY is set together with " +
        "PLANKA_AGENT_EMAIL, PLANKA_AGENT_PASSWORD. Choose one: keep PLANKA_API_KEY " +
        "(recommended) and unset the email/password pair, or unset PLANKA_API_KEY."
    );
  }

  if (!apiKey) {
    const missing: string[] = [];
    if (!email) missing.push("PLANKA_AGENT_EMAIL");
    if (!password) missing.push("PLANKA_AGENT_PASSWORD");
    if (missing.length > 0) {
      throw new PlankaConfigError(
        `Missing Planka credentials (${missing.join(", ")}). Authenticate with EITHER ` +
          "PLANKA_API_KEY (recommended: no login, no token refresh, no sign-in rate limit) " +
          "OR the pair PLANKA_AGENT_EMAIL, PLANKA_AGENT_PASSWORD."
      );
    }
  }

  // Validate URL format
  try {
    new URL(baseUrl);
  } catch {
    throw new PlankaConfigError(`Invalid PLANKA_BASE_URL: ${baseUrl}`);
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""), // Remove trailing slashes
    ...(apiKey ? { apiKey } : { email: email!, password: password! }),
  };
}

/**
 * PLANKA API client with automatic JWT token management.
 */
export class PlankaClient {
  private config: ClientConfig | null = null;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /**
   * Gets or initializes the configuration.
   */
  private getConfig(): ClientConfig {
    if (!this.config) {
      this.config = getConfig(this.env);
    }
    return this.config;
  }

  /** Request timeout in milliseconds */
  private static readonly REQUEST_TIMEOUT_MS = 30000;

  /**
   * Creates an AbortSignal with timeout.
   * Uses AbortSignal.timeout() which automatically cleans up when the request completes.
   */
  private createTimeoutSignal(): AbortSignal {
    return AbortSignal.timeout(PlankaClient.REQUEST_TIMEOUT_MS);
  }

  /**
   * Authenticates and retrieves a new JWT token.
   */
  private async authenticate(): Promise<string> {
    const config = this.getConfig();
    const url = `${config.baseUrl}/api/access-tokens`;

    let response: Response;
    try {
      response = await this.fetchImpl(
        url,
        createRequestInit("POST", {
          body: {
            emailOrUsername: config.email!,
            password: config.password!,
          },
          signal: this.createTimeoutSignal(),
        })
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlankaNetworkError(
          `Request timeout connecting to PLANKA at ${config.baseUrl}`,
          error
        );
      }
      throw new PlankaNetworkError(
        `Failed to connect to PLANKA at ${config.baseUrl}`,
        error
      );
    }

    if (!response.ok) {
      await this.safeParseJson(response);
      throw new PlankaAuthError(
        `Authentication failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await this.safeParseJson(response);
    if (data === null) {
      const redirectHint = response.redirected
        ? " The request was redirected: a 301/302 can drop the POST body. Configure the final URL directly."
        : config.baseUrl.startsWith("http://")
          ? " PLANKA_BASE_URL is http://: if the server redirects to HTTPS the POST body is dropped. Configure the final https:// URL directly."
          : " Check that PLANKA_BASE_URL points to the Planka API origin, not a proxy error page.";
      throw new PlankaAuthError(
        `Authentication returned HTML or another non-JSON response.${redirectHint}`
      );
    }

    const parsed = AuthResponse.safeParse(data);
    if (!parsed.success) {
      throw new PlankaAuthError(
        "Authentication returned JSON, but not a Planka access token response."
      );
    }

    // PLANKA tokens are valid for 30 minutes by default.
    // We refresh after 25 minutes to avoid edge cases.
    // If PLANKA's token lifetime changes, adjust this value.
    this.tokenExpiresAt = Date.now() + 25 * 60 * 1000;
    this.token = parsed.data.item;

    return parsed.data.item;
  }

  /**
   * Gets a valid token, refreshing if necessary.
   */
  private async getToken(): Promise<string> {
    if (!this.token || Date.now() >= this.tokenExpiresAt) {
      return this.authenticate();
    }
    return this.token;
  }

  /**
   * The auth material for one request: an API key when configured (no login,
   * no refresh), a bearer token otherwise. Never both — Planka ignores
   * `x-api-key` whenever `Authorization` is present.
   */
  private async authOptions(): Promise<Pick<RequestOptions, "token" | "apiKey">> {
    const config = this.getConfig();
    if (config.apiKey) return { apiKey: config.apiKey };
    return { token: await this.getToken() };
  }

  /**
   * A 200 carrying the SPA's HTML instead of JSON — Planka answers every
   * unknown GET that way, and an http:// base URL redirected to https:// ends
   * up here too. Indistinguishable from success if only the status is read.
   */
  private assertNotHtml(
    response: Response,
    data: unknown,
    what: string,
    method: string
  ): void {
    if (data !== null) return;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return;
    const config = this.getConfig();
    // The HTTP→HTTPS redirect is the most common cause, not the only one: an
    // https:// base URL that was never redirected cannot be it, and neither can
    // a plain http:// origin that answered directly.
    const redirectHint = response.redirected
      ? " The request was redirected: configure the final URL directly, a 301/302 can drop the body."
      : config.baseUrl.startsWith("http://")
        ? " PLANKA_BASE_URL is http://: if the server redirects to HTTPS, configure the final https:// URL directly. Otherwise check that it points at the Planka API origin, not a proxy error page."
        : " Check that PLANKA_BASE_URL points to the Planka API origin, not a proxy error page.";
    // A non-GET reaching here went somewhere: the SPA catch-all is GET-only, so
    // HTML on a write means a redirect or a proxy, and the write may have run.
    const writeHint =
      method === "GET"
        ? ""
        : " This was a WRITE: it MAY have landed even though the answer is unusable — re-read the entity before retrying.";
    throw new PlankaNetworkError(
      `${what} returned HTML instead of JSON: this route does not exist in Planka 2.x — ` +
        "every unknown GET under /api falls through to the single-page app, which answers 200 with HTML." +
        `${redirectHint}${writeHint}`
    );
  }

  /**
   * Safely parses JSON from a response, returning null on failure.
   */
  private async safeParseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Makes an authenticated request to the PLANKA API.
   * @param isRetry - Internal flag to prevent infinite retry loops on 401
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    isRetry = false
  ): Promise<T> {
    const config = this.getConfig();
    const auth = await this.authOptions();
    const url = `${config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(
        url,
        createRequestInit(method, {
          ...auth,
          body,
          signal: this.createTimeoutSignal(),
        })
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlankaNetworkError(
          `Request timeout: ${method} ${path} (Planka at ${config.baseUrl})`,
          error
        );
      }
      throw new PlankaNetworkError(
        `Network error: ${method} ${path} — could not reach Planka at ${config.baseUrl}. ` +
          "Check PLANKA_BASE_URL, DNS and that the instance is up.",
        error
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    const data = await this.safeParseJson(response);

    if (!response.ok) {
      // If token expired and this is not already a retry, get fresh token and retry once
      if (response.status === 401 && this.token && !isRetry) {
        this.token = null;
        this.tokenExpiresAt = 0;
        return this.request(method, path, body, true);
      }
      throw createPlankaError(response.status, data, `${method} ${path}`);
    }

    this.assertNotHtml(response, data, `${method} ${path}`, method);

    return data as T;
  }

  /**
   * POST multipart/form-data (attachment uploads).
   * @param isRetry - Internal flag to prevent infinite retry loops on 401
   */
  async postMultipart<T>(
    path: string,
    form: FormData,
    isRetry = false
  ): Promise<T> {
    const config = this.getConfig();
    const auth = await this.authOptions();
    const url = `${config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(
        url,
        createRequestInit("POST", {
          ...auth,
          form,
          signal: this.createTimeoutSignal(),
        })
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlankaNetworkError(
          `Request timeout: POST ${path} (Planka at ${config.baseUrl})`,
          error
        );
      }
      throw new PlankaNetworkError(
        `Network error: POST ${path} — could not reach Planka at ${config.baseUrl}. ` +
          "The upload MAY have started; re-read the card's attachments before retrying.",
        error
      );
    }

    const data = await this.safeParseJson(response);

    if (!response.ok) {
      if (response.status === 401 && this.token && !isRetry) {
        this.token = null;
        this.tokenExpiresAt = 0;
        return this.postMultipart(path, form, true);
      }
      throw createPlankaError(response.status, data, `POST ${path}`);
    }

    return data as T;
  }

  /**
   * Authenticated binary download (attachment contents).
   * Accepts an absolute URL on the same host, or a relative path.
   */
  async getBinary(
    urlOrPath: string,
    isRetry = false
  ): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
    const config = this.getConfig();
    const auth = await this.authOptions();
    const url = urlOrPath.startsWith("http")
      ? urlOrPath
      : `${config.baseUrl}${urlOrPath}`;

    let response: Response;
    try {
      response = await this.fetchImpl(
        url,
        createRequestInit("GET", {
          ...auth,
          // Planka serves downloads with the cookie or the API key, and some
          // deployments disagree on which one they honour.
          cookieToken: true,
          signal: this.createTimeoutSignal(),
        })
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlankaNetworkError(
          `Request timeout: GET ${url} (Planka at ${config.baseUrl})`,
          error
        );
      }
      throw new PlankaNetworkError(
        `Network error: GET ${url} — could not reach Planka at ${config.baseUrl}.`,
        error
      );
    }

    if (!response.ok) {
      // Same expired-token retry the JSON path has always had.
      if (response.status === 401 && this.token && !isRetry) {
        this.token = null;
        this.tokenExpiresAt = 0;
        return this.getBinary(urlOrPath, true);
      }
      throw createPlankaError(response.status, null, `GET ${url}`);
    }

    const buffer = await response.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      mimeType: response.headers.get("content-type"),
    };
  }

  /**
   * GET request.
   */
  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /**
   * POST request.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  /**
   * PATCH request.
   */
  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  /**
   * DELETE request.
   *
   * Returns the response body: Planka 2.x answers a delete with `{item}` of
   * what it removed, and that item carries the parent id (cardId, boardId…)
   * the caller needs to re-read the parent and prove the delete landed.
   * Discarding it made every delete a blind `success: true`.
   */
  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}

// Singleton client instance
export const plankaClient = new PlankaClient();
