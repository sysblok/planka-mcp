export class PlankaApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = "PlankaApiError";
    this.status = status;
    this.body = body;
  }
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PlankaApiError(`Invalid Planka URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new PlankaApiError("PLANKA_BASE_URL must use http:// or https://");
  }
  return url.toString().replace(/\/+$/, "");
}

async function parseResponse(response, context) {
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      const looksLikeHtml = /<\s*(?:!doctype|html|head|body)\b/i.test(text);
      const hint = looksLikeHtml
        ? " The server returned HTML instead of JSON. If the URL starts with http://, configure the final https:// URL directly; redirects can drop an authentication POST body."
        : " The response was not valid JSON.";
      throw new PlankaApiError(`${context} failed.${hint}`, {
        status: response.status,
      });
    }
  }

  if (!response.ok) {
    const detail =
      body && typeof body === "object"
        ? body.message || body.code || JSON.stringify(body)
        : response.statusText;
    throw new PlankaApiError(
      `${context} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
      { status: response.status, body }
    );
  }
  return body;
}

export async function login({ baseUrl, email, password, fetchImpl = fetch }) {
  const normalized = normalizeBaseUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(`${normalized}/api/access-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emailOrUsername: email, password }),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    if (error instanceof PlankaApiError) throw error;
    throw new PlankaApiError(
      `Could not connect to Planka at ${normalized}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (response.status >= 300 && response.status < 400) {
    const destination = response.headers.get("location");
    throw new PlankaApiError(
      `Authentication was redirected${destination ? ` to ${destination}` : ""}. Use the final https:// Planka URL directly; a 301/302 can drop the POST body.` ,
      { status: response.status }
    );
  }

  const body = await parseResponse(response, "Authentication");
  if (!body || typeof body.item !== "string") {
    throw new PlankaApiError(
      "Authentication returned JSON, but not a Planka access token. Check the base URL and credentials."
    );
  }
  return { baseUrl: normalized, token: body.item };
}

export class PlankaApi {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  static async fromCredentials(credentials) {
    const session = await login(credentials);
    return new PlankaApi({
      ...session,
      fetchImpl: credentials.fetchImpl,
    });
  }

  async request(method, path, body) {
    const headers = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new PlankaApiError(
        `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new PlankaApiError(
        `${method} ${path} was redirected. Configure the final https:// URL directly.`,
        { status: response.status }
      );
    }
    if (response.status === 204) return null;
    return parseResponse(response, `${method} ${path}`);
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body) {
    return this.request("POST", path, body);
  }

  patch(path, body) {
    return this.request("PATCH", path, body);
  }

  delete(path) {
    return this.request("DELETE", path);
  }

  getProjects() {
    return this.get("/api/projects");
  }

  getBoard(boardId) {
    return this.get(`/api/boards/${boardId}`);
  }

  createBoard(projectId, name, position = 65536) {
    return this.post(`/api/projects/${projectId}/boards`, { name, position });
  }

  createList(boardId, name, position, type = "active") {
    return this.post(`/api/boards/${boardId}/lists`, {
      name,
      position,
      type,
    });
  }

  createLabel(boardId, name, color, position) {
    return this.post(`/api/boards/${boardId}/labels`, {
      name,
      color,
      position,
    });
  }

  deleteLabel(labelId) {
    return this.delete(`/api/labels/${labelId}`);
  }

  createCard(listId, name, description = "") {
    return this.post(`/api/lists/${listId}/cards`, {
      name,
      description,
      position: 65536,
      type: "project",
    });
  }

  deleteCard(cardId) {
    return this.delete(`/api/cards/${cardId}`);
  }

  getComments(cardId) {
    return this.get(`/api/cards/${cardId}/comments`);
  }
}

export function boardEntities(payload) {
  const included = payload?.included || {};
  return {
    board: payload?.item,
    lists: Array.isArray(included.lists) ? included.lists : [],
    cards: Array.isArray(included.cards) ? included.cards : [],
    labels: Array.isArray(included.labels) ? included.labels : [],
    cardLabels: Array.isArray(included.cardLabels) ? included.cardLabels : [],
  };
}
