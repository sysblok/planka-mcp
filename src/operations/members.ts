/**
 * Card members (assignees).
 *
 * The mirror image of `setCardLabels`, and for the same reason: a 200 on
 * `POST /card-memberships` proves the request was accepted, not that the
 * person is on the card. A userId that is not a member of the board answers
 * 404 (Planka's "not found" for "not allowed"), and reporting the REQUESTED
 * assignment would leave an agent believing a card is assigned to nobody.
 *
 * So this writes, re-reads `included.cardMemberships`, and reports the final
 * membership set.
 *
 * The DELETE path is Planka's criteria syntax, `userId:<id>` — a literal colon
 * in the URL, not the membership record's own id.
 */
import { z } from "zod";
import { plankaClient } from "../client.js";
import { getCardBrief } from "./card-brief.js";

const MembershipResponse = z.object({
  item: z.object({ id: z.string(), cardId: z.string(), userId: z.string() }).passthrough(),
});

/** Put a user on a card. */
export async function addCardMember(input: {
  cardId: string;
  userId: string;
}): Promise<{ id: string; userId: string }> {
  const response = await plankaClient.post<unknown>(
    `/api/cards/${input.cardId}/card-memberships`,
    { userId: input.userId }
  );
  return MembershipResponse.parse(response).item;
}

/** Take a user off a card. */
export async function removeCardMember(input: {
  cardId: string;
  userId: string;
}): Promise<void> {
  await plankaClient.delete(
    `/api/cards/${input.cardId}/card-memberships/userId:${input.userId}`
  );
}

export interface SetCardMembersResult {
  /** Users this call put on the card. */
  added: string[];
  /** Users asked for that were already there. */
  alreadyPresent: string[];
  /** Users this call took off the card. */
  removed: string[];
  /** Users asked to be removed that were not on the card. */
  notPresent: string[];
  /** Requests that did NOT reach the desired state. */
  failed: Array<{ userId: string; reason: string }>;
  /** Every member of the card once the operation finished. */
  finalMemberIds: string[];
}

/**
 * Add and/or remove card members, then re-read to report what really landed.
 */
export async function setCardMembers(input: {
  cardId: string;
  add?: string[];
  remove?: string[];
}): Promise<SetCardMembersResult> {
  const toAdd = [...new Set(input.add ?? [])];
  const toRemove = [...new Set(input.remove ?? [])];

  const before = await getCardBrief({ cardId: input.cardId });
  const presentBefore = new Set(before.memberIds);

  const result: SetCardMembersResult = {
    added: [],
    alreadyPresent: [],
    removed: [],
    notPresent: [],
    failed: [],
    finalMemberIds: [],
  };

  // Remove first, so one call can hand a card over from one person to another.
  for (const userId of toRemove) {
    if (!presentBefore.has(userId)) {
      result.notPresent.push(userId);
      continue;
    }
    try {
      await removeCardMember({ cardId: input.cardId, userId });
    } catch (error) {
      result.failed.push({
        userId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const userId of toAdd) {
    if (presentBefore.has(userId)) {
      result.alreadyPresent.push(userId);
      continue;
    }
    try {
      await addCardMember({ cardId: input.cardId, userId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Already assigned is the desired state, not a failure.
      if (message.toLowerCase().includes("already")) {
        result.alreadyPresent.push(userId);
        continue;
      }
      result.failed.push({
        userId,
        reason:
          message +
          (message.includes("404")
            ? " (a 404 here usually means the user is not a member of this board)"
            : ""),
      });
    }
  }

  const after = await getCardBrief({ cardId: input.cardId });
  const presentAfter = new Set(after.memberIds);
  result.finalMemberIds = [...presentAfter];

  result.added = toAdd.filter((id) => presentAfter.has(id) && !presentBefore.has(id));
  result.removed = toRemove.filter((id) => !presentAfter.has(id) && presentBefore.has(id));

  // Anything asked for that the re-read contradicts is a failure, even if the
  // HTTP call came back 200.
  const reported = new Set(result.failed.map((f) => f.userId));
  for (const userId of toAdd) {
    if (!presentAfter.has(userId) && !reported.has(userId)) {
      result.failed.push({ userId, reason: "still not a member of the card after the write" });
    }
  }
  for (const userId of toRemove) {
    if (presentAfter.has(userId) && !reported.has(userId)) {
      result.failed.push({ userId, reason: "still a member of the card after the write" });
    }
  }

  return result;
}
