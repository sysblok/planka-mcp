/**
 * Errors that tell the agent what to do next.
 *
 * One test per branch: 403, 404 (with the id-type diagnosis), 401 after the
 * retry, HTML instead of JSON on a read and on a write, and a dead network.
 */
import { describe, expect, it, vi } from "vitest";
import { PlankaClient } from "../../src/client.js";
import { createPlankaError, idKindFromContext } from "../../src/errors.js";

const ENV = {
  PLANKA_BASE_URL: "https://planka.example.com",
  PLANKA_AGENT_EMAIL: "agent@example.com",
  PLANKA_AGENT_PASSWORD: "secret",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const htmlResponse = () =>
  new Response("<!doctype html><div id=root></div>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });

const token = () => jsonResponse({ item: "jwt-token" });

describe("createPlankaError", () => {
  it("says what a 403 usually means, and that Planka disguises it as 404", () => {
    const error = createPlankaError(
      403,
      { code: "E_FORBIDDEN", message: "Not enough rights" },
      "PATCH /api/cards/123"
    );

    expect(error.status).toBe(403);
    expect(error.message).toContain("Not enough rights");
    expect(error.message).toContain("PATCH /api/cards/123");
    expect(error.message).toMatch(/not a member of this board/i);
    expect(error.message).toMatch(/viewer/i);
    expect(error.message).toMatch(/404/);
  });

  it("keeps the body message on a 404 and names the id type expected there", () => {
    const error = createPlankaError(
      404,
      { code: "E_NOT_FOUND", message: "Label not found" },
      "PATCH /api/labels/123"
    );

    expect(error.status).toBe(404);
    expect(error.message).toContain("Label not found");
    expect(error.message).toContain("PATCH /api/labels/123");
    expect(error.message).toContain("labelId");
    // The documented confusion: ids are all digit strings.
    expect(error.message).toMatch(/listId/);
    expect(error.message).toMatch(/not a member of that board/i);
  });

  it("still explains a 404 whose path it cannot classify", () => {
    const error = createPlankaError(404, null, "GET /api/whatever/9");
    expect(error.message).toMatch(/404 where it means 403/i);
  });

  it("reads the id type out of a request context", () => {
    expect(idKindFromContext("PATCH /api/labels/123")).toBe("labelId");
    expect(idKindFromContext("GET /api/lists/1/cards")).toBe("listId");
    expect(idKindFromContext("GET /api/cards/1/comments?beforeId=2")).toBe("cardId");
    expect(idKindFromContext(undefined)).toBeUndefined();
  });

  it("points a surviving 401 at the credentials, not at the session", () => {
    const error = createPlankaError(401, { message: "Invalid token" }, "GET /api/cards/1");
    expect(error.message).toContain("PLANKA_API_KEY");
    expect(error.message).toContain("PLANKA_AGENT_PASSWORD");
    expect(error.message).toMatch(/renegotiated automatically/i);
  });
});

describe("PlankaClient failure messages", () => {
  it("names the SPA trap when a GET answers HTML", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(htmlResponse()) as unknown as typeof fetch;

    const client = new PlankaClient(ENV, fetchMock);
    await expect(client.get("/api/cards/1/activities")).rejects.toThrow(
      /does not exist in Planka 2\.x/
    );
  });

  it("warns that a write answered with HTML may still have landed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(htmlResponse()) as unknown as typeof fetch;

    const client = new PlankaClient(ENV, fetchMock);
    await expect(client.patch("/api/cards/1", { name: "x" })).rejects.toThrow(
      /MAY have landed.*re-read/is
    );
  });

  it("includes the base URL when Planka cannot be reached at all", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockRejectedValueOnce(new TypeError("fetch failed")) as unknown as typeof fetch;

    const client = new PlankaClient(ENV, fetchMock);
    await expect(client.get("/api/cards/1")).rejects.toThrow(
      /https:\/\/planka\.example\.com/
    );
  });

  it("retries a 401 once with a fresh token, then reports the credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(jsonResponse({ message: "Access token invalid" }, 401))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(jsonResponse({ message: "Access token invalid" }, 401)) as unknown as typeof fetch;

    const client = new PlankaClient(ENV, fetchMock);
    await expect(client.get("/api/cards/1")).rejects.toThrow(/PLANKA_AGENT_PASSWORD/);
    // One login, one call, one re-login, one retry — and no third attempt.
    expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(4);
  });
});

describe("view_attachment with nothing to view", () => {
  it("says the card has no attachments instead of asking for an id", async () => {
    vi.resetModules();
    vi.doMock("../../src/operations/attachments.js", () => ({
      getAttachmentsForCard: vi.fn(async () => []),
      downloadAttachment: vi.fn(),
      attachmentDownloadUrl: vi.fn(() => ""),
    }));

    const { viewAttachmentTool } = await import("../../src/tools/attachments.js");
    const result = await viewAttachmentTool.handler({ cardId: "card-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/has no attachments/);
    expect(result.content[0].text).not.toMatch(/pass attachmentId/);
    vi.doUnmock("../../src/operations/attachments.js");
  });
});
