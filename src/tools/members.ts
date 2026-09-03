/**
 * Card membership tool — who is assigned to a card.
 */
import { setCardMembers } from "../operations/members.js";
import { listUsers, resolveUserNames } from "../operations/users.js";
import { PlankaError } from "../errors.js";

/**
 * Tool: planka_set_card_members
 *
 * The shape mirrors planka_set_card_labels on purpose: same argument names,
 * same report of added/removed/alreadyPresent/notPresent/failed, same rule that
 * the final state is read back rather than assumed.
 */
export const setCardMembersTool = {
  name: "planka_set_card_members",
  description:
    "Assign or unassign people on a card, by user ID (names are accepted and resolved). " +
    "Re-reads the card and reports finalMemberIds — never the request.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: { type: "string", description: "The card ID" },
      add: {
        type: "array",
        items: { type: "string" },
        description: "User IDs to assign. IDs come from planka_list_users.",
      },
      remove: {
        type: "array",
        items: { type: "string" },
        description: "User IDs to unassign",
      },
      addUserNames: {
        type: "array",
        items: { type: "string" },
        description:
          "Names or usernames to assign, resolved exactly and case-insensitively. An ambiguous name fails instead of guessing.",
      },
      removeUserNames: {
        type: "array",
        items: { type: "string" },
        description: "Names or usernames to unassign",
      },
      boardId: {
        type: "string",
        description:
          "Board used to resolve names when this account cannot read the instance roster",
      },
    },
    required: ["cardId"],
  },
  handler: async (params: {
    cardId: string;
    add?: string[];
    remove?: string[];
    addUserNames?: string[];
    removeUserNames?: string[];
    boardId?: string;
  }) => {
    try {
      const add = [...(params.add ?? [])];
      const remove = [...(params.remove ?? [])];
      const addNames = params.addUserNames ?? [];
      const removeNames = params.removeUserNames ?? [];

      if (
        add.length === 0 &&
        remove.length === 0 &&
        addNames.length === 0 &&
        removeNames.length === 0
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Error: nothing to do — pass add and/or remove (user IDs), or addUserNames/removeUserNames. " +
                "User IDs come from planka_list_users.",
            },
          ],
          isError: true as const,
        };
      }

      const unresolved: Array<{ userId: string; reason: string }> = [];

      if (addNames.length > 0 || removeNames.length > 0) {
        const roster = await listUsers({ boardId: params.boardId });
        const resolvedAdd = resolveUserNames(addNames, roster.users);
        const resolvedRemove = resolveUserNames(removeNames, roster.users);
        add.push(...resolvedAdd.ids);
        remove.push(...resolvedRemove.ids);
        for (const failure of [...resolvedAdd.failed, ...resolvedRemove.failed]) {
          unresolved.push({ userId: failure.userName, reason: failure.reason });
        }
      }

      // Every name failed to resolve and there was nothing else to do: say so
      // instead of reporting a no-op success.
      if (add.length === 0 && remove.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: no user could be resolved. ${unresolved
                .map((f) => `${f.userId}: ${f.reason}`)
                .join(" · ")}`,
            },
          ],
          isError: true as const,
        };
      }

      const result = await setCardMembers({ cardId: params.cardId, add, remove });
      const failed = [...unresolved, ...result.failed];
      const ok = failed.length === 0;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: ok,
              verified: true,
              cardId: params.cardId,
              membersAdded: result.added.length,
              membersRemoved: result.removed.length,
              added: result.added,
              removed: result.removed,
              alreadyPresent: result.alreadyPresent,
              notPresent: result.notPresent,
              failed,
              finalMemberIds: result.finalMemberIds,
            }),
          },
        ],
        ...(ok ? {} : { isError: true as const }),
      };
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true as const,
        };
      }
      throw error;
    }
  },
};

export const memberTools = [setCardMembersTool];
