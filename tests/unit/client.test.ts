import { describe, expect, it, vi } from "vitest";
import {
  PlankaClient,
  createRequestInit,
  getConfig,
} from "../../src/client.js";

describe("PlankaClient", () => {
  it("builds JSON requests without leaking credentials into the URL", () => {
    const init = createRequestInit("POST", {
      token: "token-value",
      body: { emailOrUsername: "agent@example.com", password: "secret" },
    });

    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer token-value",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      emailOrUsername: "agent@example.com",
      password: "secret",
    });
  });

  it("normalizes the base URL and reports missing environment variables", () => {
    expect(
      getConfig({
        PLANKA_BASE_URL: "https://planka.example.com///",
        PLANKA_AGENT_EMAIL: "agent@example.com",
        PLANKA_AGENT_PASSWORD: "secret",
      }).baseUrl
    ).toBe("https://planka.example.com");

    expect(() => getConfig({ PLANKA_BASE_URL: "https://planka.example.com" }))
      .toThrow(/PLANKA_AGENT_EMAIL, PLANKA_AGENT_PASSWORD/);
  });

  it("explains the HTTP-to-HTTPS redirect failure when auth returns HTML", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html>login</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    ) as unknown as typeof fetch;
    const client = new PlankaClient(
      {
        PLANKA_BASE_URL: "http://planka.example.com",
        PLANKA_AGENT_EMAIL: "agent@example.com",
        PLANKA_AGENT_PASSWORD: "secret",
      },
      fetchMock
    );

    await expect(client.get("/api/projects")).rejects.toThrow(
      /redirects to HTTPS.*drop the POST body/i
    );
  });

  it("authenticates once and builds an authorized API request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ item: "jwt-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ) as unknown as typeof fetch;
    const client = new PlankaClient(
      {
        PLANKA_BASE_URL: "https://planka.example.com/",
        PLANKA_AGENT_EMAIL: "agent@example.com",
        PLANKA_AGENT_PASSWORD: "secret",
      },
      fetchMock
    );

    await expect(client.get("/api/projects")).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://planka.example.com/api/projects"
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer jwt-token" },
    });
  });
});
