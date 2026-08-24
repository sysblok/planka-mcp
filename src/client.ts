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
  email: string;
  password: string;
}

export interface RequestOptions {
  token?: string;
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
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.token && options.cookieToken) {
    headers.Cookie = `accessToken=${options.token}`;
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
  const email = env.PLANKA_AGENT_EMAIL;
  const password = env.PLANKA_AGENT_PASSWORD;

  const missing: string[] = [];
  if (!baseUrl) missing.push("PLANKA_BASE_URL");
  if (!email) missing.push("PLANKA_AGENT_EMAIL");
  if (!password) missing.push("PLANKA_AGENT_PASSWORD");

  if (missing.length > 0) {
    throw new PlankaConfigError(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  // Validate URL format
  try {
    new URL(baseUrl!);
  } catch {
    throw new PlankaConfigError(`Invalid PLANKA_BASE_URL: ${baseUrl}`);
  }

  // TypeScript narrowing: after the check above, these are guaranteed to be defined
  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""), // Remove trailing slashes
    email: email!,
    password: password!,
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
            emailOrUsername: config.email,
            password: config.password,
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
      const redirectHint =
        config.baseUrl.startsWith("http://") || response.redirected
          ? " Your HTTP URL probably redirects to HTTPS; a 301/302 can drop the POST body. Configure the final https:// URL directly."
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
    const token = await this.getToken();
    const url = `${config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(
        url,
        createRequestInit(method, {
          token,
          body,
          signal: this.createTimeoutSignal(),
        })
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlankaNetworkError(`Request timeout: ${method} ${path}`, error);
      }
      throw new PlankaNetworkError(`Network error: ${method} ${path}`, error);
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
    const token = await this.getToken();
    const url = `${config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(
        url,
        createRequestInit("POST", {
          token,
          form,
          signal: this.createTimeoutSignal(),
        })
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlankaNetworkError(`Request timeout: POST ${path}`, error);
      }
      throw new PlankaNetworkError(`Network error: POST ${path}`, error);
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
    urlOrPath: string
  ): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
    const config = this.getConfig();
    const token = await this.getToken();
    const url = urlOrPath.startsWith("http")
      ? urlOrPath
      : `${config.baseUrl}${urlOrPath}`;

    let response: Response;
    try {
      response = await this.fetchImpl(
        url,
        createRequestInit("GET", {
          token,
          cookieToken: true,
          signal: this.createTimeoutSignal(),
        })
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlankaNetworkError(`Request timeout: GET ${url}`, error);
      }
      throw new PlankaNetworkError(`Network error: GET ${url}`, error);
    }

    if (!response.ok) {
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
   */
  async delete(path: string): Promise<void> {
    return this.request<void>("DELETE", path);
  }
}

// Singleton client instance
export const plankaClient = new PlankaClient();
