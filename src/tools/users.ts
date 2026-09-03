/**
 * Identity tools: who can be assigned, and who this server is.
 */
import {
  getBoardMembership,
  getCurrentUser,
  getPlankaVersion,
  listUsers,
} from "../operations/users.js";
import { getConfig } from "../client.js";
import { getPolicy } from "../config/policy.js";
import { PlankaError } from "../errors.js";

function errorResult(error: unknown) {
  if (error instanceof PlankaError) {
    return {
      content: [{ type: "text" as const, text: `Error: ${error.message}` }],
      isError: true as const,
    };
  }
  throw error;
}

/**
 * Tool: planka_list_users
 */
export const listUsersTool = {
  name: "planka_list_users",
  description:
    "The people who can be assigned, with their IDs. Falls back to the board's members when this " +
    "account may not read the instance roster, and says so in `source`. Emails only with detail: full.",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: {
        type: "string",
        description:
          "Board to fall back to when the instance roster is refused (403). Ignored otherwise.",
      },
      detail: {
        type: "string",
        enum: ["digest", "full"],
        description: "digest (default) hides email addresses; full includes them.",
      },
    },
  },
  handler: async (params: { boardId?: string; detail?: "digest" | "full" }) => {
    try {
      const result = await listUsers({
        boardId: params.boardId,
        detail: params.detail,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              source: result.source,
              ...(result.boardId ? { boardId: result.boardId } : {}),
              ...(result.fellBackBecause ? { note: result.fellBackBecause } : {}),
              total: result.users.length,
              users: result.users,
            }),
          },
        ],
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};

/**
 * Tool: planka_whoami
 *
 * The first call to make when something answers 404 that should not: it says
 * which account this is, what it may do on the board, and what the local policy
 * has switched off — the three usual causes of a confusing refusal.
 */
export const whoamiTool = {
  name: "planka_whoami",
  description:
    "This server's identity and limits: the Planka account, its board role, the Planka version, " +
    "and the local access policy (default board, allowlist, read-only, disabled tools).",
  inputSchema: {
    type: "object" as const,
    properties: {
      boardId: {
        type: "string",
        description: "Board to report membership for. Defaults to the configured board.",
      },
    },
  },
  handler: async (params: { boardId?: string } = {}) => {
    try {
      const policy = getPolicy();
      const user = await getCurrentUser();

      let authMode: "apiKey" | "password" | "unknown" = "unknown";
      try {
        authMode = getConfig().apiKey ? "apiKey" : "password";
      } catch {
        // A config error would have stopped the call above; stay silent.
      }

      let plankaVersion: string | null = null;
      let versionWarning: string | undefined;
      try {
        plankaVersion = await getPlankaVersion();
      } catch {
        versionWarning = "The Planka version could not be read from /api/bootstrap.";
      }
      if (plankaVersion && !plankaVersion.startsWith("2.")) {
        versionWarning =
          `This server targets Planka 2.x and the instance reports ${plankaVersion}. ` +
          `Endpoints, response shapes and the card-membership paths may differ.`;
      }

      const boardId =
        params?.boardId ?? policy.defaultBoardId ?? policy.allowedBoardIds?.[0] ?? null;

      let boardMembership: {
        boardId: string;
        role: string | null;
        canComment: boolean | null;
      } | null = null;
      if (boardId) {
        try {
          const membership = await getBoardMembership({ boardId, userId: user.id });
          boardMembership = membership
            ? {
                boardId,
                role: membership.role ?? null,
                canComment: membership.canComment ?? null,
              }
            : null;
        } catch {
          boardMembership = null;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              user: {
                id: user.id,
                name: user.name ?? user.username ?? user.id,
                ...(user.username ? { username: user.username } : {}),
                ...(user.role ? { role: user.role } : {}),
              },
              plankaVersion,
              ...(versionWarning ? { versionWarning } : {}),
              authMode,
              boardMembership,
              ...(boardId && !boardMembership
                ? {
                    membershipNote:
                      `No board membership found for this user on board ${boardId}. ` +
                      `An admin can still read it; a boardUser could not write to it.`,
                  }
                : {}),
              policy: {
                defaultBoardId: policy.defaultBoardId,
                allowedBoardIds: policy.allowedBoardIds,
                allowedProjectIds: policy.allowedProjectIds,
                readOnly: policy.readOnly,
                disabledTools: policy.disabledTools,
                protectedListIds: policy.protectedListIds,
              },
            }),
          },
        ],
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const userTools = [listUsersTool, whoamiTool];
