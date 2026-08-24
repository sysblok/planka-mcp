import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestInit } from "../../src/client.js";

const mocks = vi.hoisted(() => ({ get: vi.fn(), postMultipart: vi.fn() }));

vi.mock("../../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client.js")>();
  return {
    ...actual,
    plankaClient: { get: mocks.get, postMultipart: mocks.postMultipart },
  };
});

import {
  attachmentDownloadUrl,
  getAttachmentsForCard,
  guessMimeType,
  uploadAttachment,
} from "../../src/operations/attachments.js";

const attachment = {
  id: "attachment-1",
  cardId: "card-1",
  name: "before-fix.png",
  type: "file",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
};

describe("attachments", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.postMultipart.mockReset();
  });

  it("leaves Content-Type to fetch on multipart uploads", () => {
    const init = createRequestInit("POST", {
      token: "token-value",
      form: new FormData(),
    });

    expect(init.headers).toEqual({ Authorization: "Bearer token-value" });
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("sends the token as a cookie too when downloading binaries", () => {
    expect(
      createRequestInit("GET", { token: "token-value", cookieToken: true })
        .headers
    ).toMatchObject({ Cookie: "accessToken=token-value" });
  });

  it("guesses MIME types from the file extension", () => {
    expect(guessMimeType({ filePath: "/tmp/shot.PNG" })).toBe("image/png");
    expect(guessMimeType({ filePath: "/tmp/server.log" })).toBe("text/plain");
    expect(guessMimeType({ filePath: "/tmp/blob.bin" })).toBe(
      "application/octet-stream"
    );
  });

  it("prefers the Planka 2.x data.url and falls back to the download path", () => {
    expect(
      attachmentDownloadUrl({
        attachment: { ...attachment, data: { url: "/attachments/1/download/x" } },
      })
    ).toBe("/attachments/1/download/x");

    expect(attachmentDownloadUrl({ attachment })).toBe(
      "/attachments/attachment-1/download/before-fix.png"
    );
  });

  it("reads attachments from the card endpoint's included payload", async () => {
    mocks.get.mockResolvedValue({
      item: {
        id: "card-1",
        boardId: "board-1",
        listId: "list-1",
        name: "Card",
        type: "project",
        position: 65536,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: null,
      },
      included: { attachments: [attachment] },
    });

    await expect(
      getAttachmentsForCard({ cardId: "card-1" })
    ).resolves.toMatchObject([{ id: "attachment-1" }]);
    expect(mocks.get).toHaveBeenCalledWith("/api/cards/card-1");
  });

  it("refuses an empty cardId before touching the network", async () => {
    await expect(getAttachmentsForCard({ cardId: "" })).rejects.toThrow(
      /cardId is required/
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("uploads with the type and name Planka 2.0 requires", async () => {
    mocks.postMultipart.mockResolvedValue({ item: attachment });

    const file = new URL("./fixtures/attachment.txt", import.meta.url);
    await expect(
      uploadAttachment({ cardId: "card-1", filePath: file.pathname })
    ).resolves.toMatchObject({ id: "attachment-1" });

    const [path, form] = mocks.postMultipart.mock.calls[0];
    expect(path).toBe("/api/cards/card-1/attachments");
    expect(form.get("type")).toBe("file");
    expect(form.get("name")).toBe("attachment.txt");
  });
});
