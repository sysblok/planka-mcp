/**
 * Custom field tools for PLANKA MCP server.
 *
 * Fills or clears a field that already exists on a card. It never creates a
 * field: a name the card does not have comes back as an error that lists the
 * fields it does have, so the model can correct itself instead of guessing.
 */
import {
  CardCustomFields,
  CustomFieldSlot,
  CUSTOM_FIELD_CONTENT_MAX,
  deleteCustomFieldValue,
  getCardCustomFields,
  slotKey,
  writeCustomFieldValue,
} from "../operations/custom-fields.js";
import { getCardLight } from "../operations/cards.js";
import { verifiedDelete, verifiedWrite, writeResult } from "../operations/verify.js";
import { assertBoardAllowed, assertListWritable } from "../config/policy.js";
import { guarded } from "./guard.js";

/** The shape every tool shows a slot in. */
export function presentSlot(s: CustomFieldSlot) {
  return {
    group: s.group,
    field: s.field,
    content: s.content,
    scope: s.scope,
    groupId: s.groupId,
    fieldId: s.fieldId,
  };
}

const norm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFC").trim().toLocaleLowerCase();

type Resolution =
  | { kind: "one"; slot: CustomFieldSlot }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: CustomFieldSlot[] };

/** By id first, then by name; `group` (id or name) narrows either. */
export function resolveSlot(
  slots: CustomFieldSlot[],
  field: string,
  group?: string
): Resolution {
  const inGroup = group
    ? slots.filter((s) => s.groupId === group || norm(s.group) === norm(group))
    : slots;
  const byId = inGroup.filter((s) => s.fieldId === field);
  const matches = byId.length > 0 ? byId : inGroup.filter((s) => norm(s.field) === norm(field));
  if (matches.length === 1) return { kind: "one", slot: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", candidates: matches };
}

function refusal(body: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, ...body }) }],
    isError: true as const,
  };
}

function notFound(cardId: string, field: string, group: string | undefined, cf: CardCustomFields) {
  const where = group ? ` in group "${group}"` : "";
  const fix =
    "This tool only fills fields that already exist; it never creates one. " +
    "A field is added in Planka's UI (the board's or the card's custom fields).";
  return refusal({
    error: "custom_field_not_found",
    message:
      cf.slots.length === 0
        ? `Card ${cardId} has no custom fields at all, so "${field}" cannot be set. ${fix}`
        : `Card ${cardId} has no custom field "${field}"${where}. Use one of availableFields (by name or fieldId). ${fix}`,
    cardId,
    requestedField: field,
    ...(group ? { requestedGroup: group } : {}),
    availableFields: cf.slots.map(presentSlot),
    ...(cf.incomplete ? { incomplete: cf.incomplete } : {}),
  });
}

/**
 * Tool: planka_set_custom_field
 */
export const setCustomFieldTool = {
  name: "planka_set_custom_field",
  description:
    "Fill or clear a custom field that already exists on a card (from the board's or the card's own groups), by field name or fieldId. " +
    'It never creates a field: an unknown one comes back as error "custom_field_not_found" with the card\'s availableFields. ' +
    "Verified by re-reading the card.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: { type: "string", description: "The card ID" },
      field: {
        type: "string",
        description:
          'Field name (case-insensitive, e.g. "Google Doc") or fieldId, as planka_get_card detail:"full" lists them in customFields.',
      },
      group: {
        type: "string",
        description:
          "Group name or groupId. Only needed when the same field name exists in several groups.",
      },
      content: {
        type: ["string", "null"],
        description: `New value, at most ${CUSTOM_FIELD_CONTENT_MAX} characters. null or "" clears the field.`,
      },
    },
    required: ["cardId", "field", "content"],
  },
  handler: async (params: {
    cardId: string;
    field: string;
    group?: string;
    content: string | null;
  }) =>
    guarded(async () => {
      const clear = params.content === null || params.content === "";
      const content = clear ? null : (params.content as string);
      if (content !== null && content.length > CUSTOM_FIELD_CONTENT_MAX) {
        return refusal({
          error: "content_too_long",
          message: `content is ${content.length} characters; Planka accepts at most ${CUSTOM_FIELD_CONTENT_MAX}`,
        });
      }

      // The cached board structure first; anything short of one clean match
      // is re-read fresh before "no such field" is ever said.
      let cf = await getCardCustomFields(params.cardId, { fresh: false });
      assertBoardAllowed(cf.card.card.boardId);
      assertListWritable(cf.card.card.listId, undefined, "edit custom fields of cards in");

      let res = resolveSlot(cf.slots, params.field, params.group);
      if (res.kind !== "one" || cf.incomplete) {
        cf = await getCardCustomFields(params.cardId, { fresh: true, card: cf.card });
        res = resolveSlot(cf.slots, params.field, params.group);
      }

      if (res.kind === "none") return notFound(params.cardId, params.field, params.group, cf);
      if (res.kind === "ambiguous") {
        return refusal({
          error: "custom_field_ambiguous",
          message: `"${params.field}" matches ${res.candidates.length} fields on card ${params.cardId}; pass group (name or groupId) or the fieldId`,
          candidates: res.candidates.map(presentSlot),
        });
      }

      const slot = res.slot;
      const key = slotKey(slot.groupId, slot.fieldId);
      const base = { cardId: params.cardId, field: presentSlot(slot), previous: slot.content };

      if (slot.content === content) {
        return writeResult(
          { ...base, content, changed: false, message: "already set to that value" },
          { verified: true }
        );
      }

      const filledNow = async () => {
        const after = await getCardLight({ cardId: params.cardId });
        const v = after.customFieldValues.find(
          (x) => slotKey(x.customFieldGroupId, x.customFieldId) === key
        );
        return v?.content ? v.content : null;
      };

      if (content === null) {
        const deleted = await verifiedDelete({
          del: () => deleteCustomFieldValue(params.cardId, slot.groupId, slot.fieldId),
          confirmGone: async () => (await filledNow()) === null,
        });
        return writeResult(
          { ...base, content: deleted.verified ? null : "unknown", changed: deleted.verified },
          deleted
        );
      }

      const written = await verifiedWrite({
        write: () => writeCustomFieldValue(params.cardId, slot.groupId, slot.fieldId, content),
        reread: () => filledNow(),
        landed: (after) => after === content,
      });
      return writeResult(
        {
          ...base,
          content: written.after !== undefined ? written.after : "unknown",
          changed: written.verified,
        },
        written
      );
    }),
};

export const customFieldTools = [setCustomFieldTool];
