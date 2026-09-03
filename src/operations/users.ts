/**
 * Who exists in this Planka, and who this server is logged in as.
 *
 * `GET /api/users` is admin-or-projectOwner only (`policies.js`): an agent
 * running as the recommended `boardUser` gets 403 and would be left unable to
 * assign anybody. So every read here has a board-scoped fallback — the board
 * show carries `included.users` and `included.boardMemberships` for exactly
 * the people who can be assigned on that board, which is the useful set anyway.
 *
 * The fallback is never silent: the result says `source: "board"` so a caller
 * knows it is looking at the board's members, not the instance's roster.
 */
import { z } from "zod";
import { plankaClient } from "../client.js";
import { PlankaError } from "../errors.js";
import { withBoardId } from "./board-id.js";

const UserRowSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    isDeactivated: z.boolean().nullable().optional(),
  })
  .passthrough();
export type UserRow = z.infer<typeof UserRowSchema>;

const UsersResponse = z.object({ items: z.array(UserRowSchema) });
const UserResponse = z.object({ item: UserRowSchema });

const BoardMembershipSchema = z
  .object({
    id: z.string(),
    boardId: z.string(),
    userId: z.string(),
    role: z.string().nullable().optional(),
    canComment: z.boolean().nullable().optional(),
  })
  .passthrough();
export type BoardMembership = z.infer<typeof BoardMembershipSchema>;

const BoardUsersResponse = z.object({
  included: z
    .object({
      users: z.array(UserRowSchema).optional(),
      boardMemberships: z.array(BoardMembershipSchema).optional(),
    })
    .passthrough()
    .optional(),
});

const ProjectsMembershipsResponse = z.object({
  included: z
    .object({
      boardMemberships: z.array(BoardMembershipSchema).optional(),
    })
    .passthrough()
    .optional(),
});

const BootstrapResponse = z.object({
  item: z.object({ version: z.string().optional() }).passthrough(),
});

/** One user, reduced to what an assignment decision needs. */
export interface UserDigest {
  id: string;
  name: string;
  username?: string;
  role?: string;
  /** Only in the board-scoped view: "editor" | "viewer". */
  boardRole?: string;
  canComment?: boolean;
  /** Only with detail: "full" — an address is PII, not a routing key. */
  email?: string;
  isDeactivated?: boolean;
}

export interface ListUsersResult {
  /** "instance" = GET /api/users · "board" = the board's own members. */
  source: "instance" | "board";
  boardId?: string;
  users: UserDigest[];
  /** Set when the instance roster was refused and the board answered instead. */
  fellBackBecause?: string;
}

function digestUser(
  user: UserRow,
  membership: BoardMembership | undefined,
  full: boolean
): UserDigest {
  return {
    id: user.id,
    name: user.name ?? user.username ?? user.id,
    ...(user.username ? { username: user.username } : {}),
    ...(user.role ? { role: user.role } : {}),
    ...(membership?.role ? { boardRole: membership.role } : {}),
    ...(membership && membership.canComment !== null && membership.canComment !== undefined
      ? { canComment: membership.canComment }
      : {}),
    ...(full && user.email ? { email: user.email } : {}),
    ...(user.isDeactivated ? { isDeactivated: true } : {}),
  };
}

/** True for the 403 Planka answers a `boardUser` asking for the roster. */
function isForbidden(error: unknown): boolean {
  return error instanceof PlankaError && (error.status === 403 || error.status === 401);
}

/**
 * Everyone this server can see, instance-wide when allowed and board-scoped
 * otherwise.
 */
export async function listUsers(
  input: { boardId?: string; detail?: "digest" | "full" } = {}
): Promise<ListUsersResult> {
  const full = input.detail === "full";

  try {
    const response = await plankaClient.get<unknown>("/api/users");
    const parsed = UsersResponse.parse(response);
    return {
      source: "instance",
      users: parsed.items.map((user) => digestUser(user, undefined, full)),
    };
  } catch (error) {
    if (!isForbidden(error)) throw error;

    const board = await listBoardUsers({ boardId: input.boardId, detail: input.detail });
    return {
      ...board,
      fellBackBecause:
        "GET /api/users is admin-only and this account is not an admin; " +
        "these are the members of the board instead.",
    };
  }
}

/** The board's own members, with their board role. */
export async function listBoardUsers(input: {
  boardId?: string;
  detail?: "digest" | "full";
}): Promise<ListUsersResult> {
  const full = input.detail === "full";

  return withBoardId(input.boardId, async (boardId) => {
    const response = await plankaClient.get<unknown>(`/api/boards/${boardId}`);
    const parsed = BoardUsersResponse.parse(response);
    const memberships = parsed.included?.boardMemberships ?? [];
    const byUser = new Map(memberships.map((m) => [m.userId, m]));

    return {
      source: "board" as const,
      boardId,
      users: (parsed.included?.users ?? []).map((user) =>
        digestUser(user, byUser.get(user.id), full)
      ),
    };
  });
}

/** The account this server authenticates as. */
export async function getCurrentUser(): Promise<UserRow> {
  const response = await plankaClient.get<unknown>("/api/users/me");
  return UserResponse.parse(response).item;
}

/**
 * The Planka version.
 *
 * `/api/bootstrap` is the ONLY endpoint that carries it in 2.x — `/api/config`
 * returns SMTP settings and nothing else, and `/swagger.json` is not served.
 */
export async function getPlankaVersion(): Promise<string | null> {
  const response = await plankaClient.get<unknown>("/api/bootstrap");
  return BootstrapResponse.parse(response).item.version ?? null;
}

/**
 * This user's membership on one board, read from `/api/projects` (3 kB) rather
 * than from the board show (~900 kB): both carry `boardMemberships`.
 */
export async function getBoardMembership(input: {
  boardId: string;
  userId: string;
}): Promise<BoardMembership | null> {
  const response = await plankaClient.get<unknown>("/api/projects");
  const parsed = ProjectsMembershipsResponse.parse(response);
  return (
    (parsed.included?.boardMemberships ?? []).find(
      (m) => m.boardId === input.boardId && m.userId === input.userId
    ) ?? null
  );
}

/**
 * Resolves names or usernames to user ids.
 *
 * Case-insensitive, exact match on `username` first and then on `name`. An
 * ambiguous name is NOT guessed: assigning the wrong person is worse than
 * failing, so it comes back in `failed`.
 */
export function resolveUserNames(
  names: string[],
  users: UserDigest[]
): { ids: string[]; failed: Array<{ userName: string; reason: string }> } {
  const ids: string[] = [];
  const failed: Array<{ userName: string; reason: string }> = [];

  for (const raw of names) {
    const wanted = raw.trim().toLowerCase();
    if (!wanted) {
      failed.push({ userName: raw, reason: "empty name" });
      continue;
    }

    const byUsername = users.filter((u) => u.username?.toLowerCase() === wanted);
    const matches =
      byUsername.length > 0
        ? byUsername
        : users.filter((u) => u.name.toLowerCase() === wanted);

    if (matches.length === 0) {
      failed.push({
        userName: raw,
        reason: `no user named "${raw}" — call planka_list_users for the real names`,
      });
      continue;
    }
    if (matches.length > 1) {
      failed.push({
        userName: raw,
        reason: `"${raw}" matches ${matches.length} users (${matches
          .map((u) => u.id)
          .join(", ")}); pass the userId`,
      });
      continue;
    }
    ids.push(matches[0].id);
  }

  return { ids, failed };
}
