import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client.js")>();
  return {
    ...actual,
    plankaClient: { get: mocks.get, post: mocks.post, delete: mocks.del },
  };
});

import { PlankaError } from "../../src/errors.js";
import { setCardMembersTool } from "../../src/tools/members.js";
import { listUsersTool, whoamiTool } from "../../src/tools/users.js";

const parse = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text);

/** A card show carrying exactly the memberships given. */
function cardWith(userIds: string[]) {
  return {
    item: {
      id: "card-1",
      boardId: "board-1",
      listId: "list-1",
      name: "Card one",
      position: 65536,
    },
    included: {
      cardMemberships: userIds.map((userId, index) => ({
        id: `m-${index}`,
        cardId: "card-1",
        userId,
      })),
    },
  };
}

const USERS = [
  { id: "u-1", name: "Pablo", username: "admin", role: "admin", email: "p@x.com" },
  { id: "u-2", name: "Claude", username: "claude", role: "admin", email: "c@x.com" },
  { id: "u-3", name: "Fede", username: "fede", role: "boardUser" },
];

describe("planka_set_card_members", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.del.mockReset();
  });

  it("adds and removes, then reports the re-read membership", async () => {
    mocks.get
      .mockResolvedValueOnce(cardWith(["u-1"])) // before
      .mockResolvedValueOnce(cardWith(["u-2"])); // after
    mocks.post.mockResolvedValue({
      item: { id: "m-new", cardId: "card-1", userId: "u-2" },
    });
    mocks.del.mockResolvedValue({});

    const payload = parse(
      await setCardMembersTool.handler({
        cardId: "card-1",
        add: ["u-2"],
        remove: ["u-1"],
      })
    );

    expect(mocks.post).toHaveBeenCalledWith("/api/cards/card-1/card-memberships", {
      userId: "u-2",
    });
    // Planka's criteria syntax, not the membership record's own id.
    expect(mocks.del).toHaveBeenCalledWith(
      "/api/cards/card-1/card-memberships/userId:u-1"
    );
    expect(payload).toMatchObject({
      success: true,
      verified: true,
      added: ["u-2"],
      removed: ["u-1"],
      finalMemberIds: ["u-2"],
    });
  });

  it("fails when the re-read says the member never landed", async () => {
    mocks.get
      .mockResolvedValueOnce(cardWith([]))
      .mockResolvedValueOnce(cardWith([])); // Planka answered 200 and did nothing
    mocks.post.mockResolvedValue({
      item: { id: "m-new", cardId: "card-1", userId: "u-2" },
    });

    const result = await setCardMembersTool.handler({
      cardId: "card-1",
      add: ["u-2"],
    });
    const payload = parse(result);

    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.added).toEqual([]);
    expect(payload.failed[0]).toMatchObject({ userId: "u-2" });
  });

  it("reports a user that is not on the card as notPresent, not as removed", async () => {
    mocks.get
      .mockResolvedValueOnce(cardWith(["u-1"]))
      .mockResolvedValueOnce(cardWith(["u-1"]));

    const payload = parse(
      await setCardMembersTool.handler({ cardId: "card-1", remove: ["u-9"] })
    );

    expect(mocks.del).not.toHaveBeenCalled();
    expect(payload.notPresent).toEqual(["u-9"]);
    expect(payload.success).toBe(true);
  });

  it("resolves names through the roster", async () => {
    mocks.get
      .mockResolvedValueOnce({ items: USERS }) // GET /api/users
      .mockResolvedValueOnce(cardWith([]))
      .mockResolvedValueOnce(cardWith(["u-3"]));
    mocks.post.mockResolvedValue({
      item: { id: "m", cardId: "card-1", userId: "u-3" },
    });

    const payload = parse(
      await setCardMembersTool.handler({
        cardId: "card-1",
        addUserNames: ["fede"],
      })
    );

    expect(payload.added).toEqual(["u-3"]);
    expect(payload.success).toBe(true);
  });

  it("refuses a name it cannot resolve instead of assigning nobody", async () => {
    mocks.get.mockResolvedValueOnce({ items: USERS });

    const result = await setCardMembersTool.handler({
      cardId: "card-1",
      addUserNames: ["nadie"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no user named "nadie"/);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("refuses a call with nothing to do", async () => {
    const result = await setCardMembersTool.handler({ cardId: "card-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to do/i);
  });
});

describe("planka_list_users", () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("uses the instance roster and hides emails by default", async () => {
    mocks.get.mockResolvedValue({ items: USERS });

    const payload = parse(await listUsersTool.handler({}));

    expect(mocks.get).toHaveBeenCalledWith("/api/users");
    expect(payload.source).toBe("instance");
    expect(payload.total).toBe(3);
    expect(payload.users[0]).toEqual({
      id: "u-1",
      name: "Pablo",
      username: "admin",
      role: "admin",
    });
  });

  it("includes emails with detail: full", async () => {
    mocks.get.mockResolvedValue({ items: USERS });
    const payload = parse(await listUsersTool.handler({ detail: "full" }));
    expect(payload.users[0].email).toBe("p@x.com");
  });

  it("falls back to the board's members on a 403 and says so", async () => {
    mocks.get
      .mockRejectedValueOnce(new PlankaError("Forbidden", "E_FORBIDDEN", 403))
      .mockResolvedValueOnce({
        item: { id: "board-1" },
        included: {
          users: [USERS[2]],
          boardMemberships: [
            {
              id: "bm-1",
              boardId: "board-1",
              userId: "u-3",
              role: "editor",
              canComment: true,
            },
          ],
        },
      });

    const payload = parse(await listUsersTool.handler({ boardId: "board-1" }));

    expect(payload.source).toBe("board");
    expect(payload.boardId).toBe("board-1");
    expect(payload.note).toMatch(/admin-only/);
    expect(payload.users[0]).toMatchObject({
      id: "u-3",
      boardRole: "editor",
      canComment: true,
    });
  });
});

describe("planka_whoami", () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  it("reports the account, the version and the board membership", async () => {
    mocks.get
      .mockResolvedValueOnce({ item: USERS[1] }) // /api/users/me
      .mockResolvedValueOnce({ item: { version: "2.2.1" } }) // /api/bootstrap
      .mockResolvedValueOnce({
        included: {
          boardMemberships: [
            {
              id: "bm",
              boardId: "board-1",
              userId: "u-2",
              role: "editor",
              canComment: null,
            },
          ],
        },
      });

    const payload = parse(await whoamiTool.handler({ boardId: "board-1" }));

    expect(mocks.get).toHaveBeenNthCalledWith(1, "/api/users/me");
    expect(mocks.get).toHaveBeenNthCalledWith(2, "/api/bootstrap");
    // The cheap source of memberships: /api/projects, not the board show.
    expect(mocks.get).toHaveBeenNthCalledWith(3, "/api/projects");
    expect(payload.user).toMatchObject({ id: "u-2", name: "Claude", role: "admin" });
    expect(payload.plankaVersion).toBe("2.2.1");
    expect(payload.versionWarning).toBeUndefined();
    expect(payload.boardMembership).toEqual({
      boardId: "board-1",
      role: "editor",
      canComment: null,
    });
    expect(payload.policy).toHaveProperty("readOnly");
  });

  it("warns when the instance is not a Planka 2.x", async () => {
    mocks.get
      .mockResolvedValueOnce({ item: USERS[1] })
      .mockResolvedValueOnce({ item: { version: "1.26.2" } })
      .mockResolvedValueOnce({ included: { boardMemberships: [] } });

    const payload = parse(await whoamiTool.handler({ boardId: "board-1" }));

    expect(payload.versionWarning).toMatch(/1\.26\.2/);
    expect(payload.boardMembership).toBeNull();
    expect(payload.membershipNote).toMatch(/No board membership/);
  });
});
