/**
 * A card read that survives the cards the strict schemas cannot describe.
 *
 * Two reasons this exists next to `getCardLight`:
 *
 * 1. An ARCHIVED card comes back with `position: null`. `CardSchema` types
 *    position as a number, so parsing an archived card throws — which would
 *    make `planka_archive_card` unable to verify its own write.
 * 2. `included.cardMemberships` is what `planka_set_card_members` has to
 *    compare against, and no existing read exposes it.
 *
 * Deliberately permissive (`passthrough`, everything optional that Planka may
 * omit): this is a verification read, and a verification read that throws is
 * worse than one that returns a field it does not understand.
 */
import { z } from "zod";
import { plankaClient } from "../client.js";
import { parseInput } from "../errors.js";
import { CardIdSchema, CardIdInput } from "../schemas/requests.js";

/** Card row as read for verification: nothing required beyond identity. */
export const CardBriefSchema = z
  .object({
    id: z.string(),
    boardId: z.string(),
    listId: z.string(),
    name: z.string(),
    /** null on archived cards — the reason this schema exists. */
    position: z.number().nullable().optional(),
    /** Where Planka will send the card back to when it leaves the archive. */
    prevListId: z.string().nullable().optional(),
    isClosed: z.boolean().nullable().optional(),
    listChangedAt: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .passthrough();
export type CardBrief = z.infer<typeof CardBriefSchema>;

export const CardMembershipSchema = z
  .object({
    id: z.string(),
    cardId: z.string(),
    userId: z.string(),
  })
  .passthrough();
export type CardMembership = z.infer<typeof CardMembershipSchema>;

const CardBriefResponse = z.object({
  item: CardBriefSchema,
  included: z
    .object({
      cardMemberships: z.array(CardMembershipSchema).optional(),
      cardLabels: z.array(z.object({ labelId: z.string() }).passthrough()).optional(),
      taskLists: z.array(z.unknown()).optional(),
      tasks: z.array(z.unknown()).optional(),
      attachments: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});

export interface CardBriefResult {
  card: CardBrief;
  memberships: CardMembership[];
  memberIds: string[];
  /** What a duplicate is expected to carry over. */
  counts: {
    tasks: number;
    taskLists: number;
    labels: number;
    members: number;
    attachments: number;
  };
}

/**
 * One GET of a card, parsed loosely, with its memberships.
 */
export async function getCardBrief(input: CardIdInput): Promise<CardBriefResult> {
  const { cardId } = parseInput(CardIdSchema, input);
  const response = await plankaClient.get<unknown>(`/api/cards/${cardId}`);
  const parsed = CardBriefResponse.parse(response);
  const included = parsed.included ?? {};
  const memberships = included.cardMemberships ?? [];

  return {
    card: parsed.item,
    memberships,
    memberIds: memberships.map((m) => m.userId),
    counts: {
      tasks: included.tasks?.length ?? 0,
      taskLists: included.taskLists?.length ?? 0,
      labels: included.cardLabels?.length ?? 0,
      members: memberships.length,
      attachments: included.attachments?.length ?? 0,
    },
  };
}
