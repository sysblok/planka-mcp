/**
 * Custom fields of a card: every slot it has, filled or not, and the write.
 *
 * Planka 2.x keys a value by (card, group, field). The groups a card shows are
 *
 *   - BOARD-level groups (`boardId` set): on every card of the board, served
 *     only by the board show;
 *   - CARD-level groups (`cardId` set): on that card only, served by the card
 *     show.
 *
 * Either kind may be instantiated from a project's BASE group
 * (`baseCustomFieldGroupId` set). Then its fields belong to the base group,
 * not to the group itself, and only the project show lists them.
 *
 * So the full set of slots takes the card show, the board show and — only when
 * a base group is in play — the project show.
 */
import { plankaClient } from "../client.js";
import { PlankaError } from "../errors.js";
import {
  CustomField,
  CustomFieldGroup,
  CustomFieldGroupSchema,
  CustomFieldSchema,
} from "../schemas/entities.js";
import {
  BoardNames,
  CardLightDetails,
  fetchBoardNames,
  getBoardNames,
  getCardLight,
  rowsOf,
} from "./cards.js";

/** Planka's own limit on `content` (custom-field-values/create-or-update). */
export const CUSTOM_FIELD_CONTENT_MAX = 512;

export interface CustomFieldSlot {
  groupId: string;
  group: string | null;
  /** "board": shown on every card of the board. "card": this card's own. */
  scope: "board" | "card";
  fieldId: string;
  field: string | null;
  /** null when the field is empty on this card. */
  content: string | null;
}

export interface CardCustomFields {
  card: CardLightDetails;
  slots: CustomFieldSlot[];
  /** Values whose group or field definition could not be found. */
  orphans: Array<{ groupId: string | null; fieldId: string; content: string | null }>;
  /** Set when part of the structure could not be read; the slots are then partial. */
  incomplete?: string;
}

interface ProjectBaseFields {
  groupNames: Map<string, string | null>;
  fields: CustomField[];
}

async function fetchProjectBaseFields(projectId: string): Promise<ProjectBaseFields> {
  const response = await plankaClient.get<unknown>(`/api/projects/${projectId}`);
  const included = (response as { included?: Record<string, unknown> }).included;
  const groupNames = new Map<string, string | null>();
  for (const g of rowsOf(CustomFieldGroupSchema, included?.baseCustomFieldGroups)) {
    groupNames.set(g.id, g.name ?? null);
  }
  return {
    groupNames,
    fields: rowsOf(CustomFieldSchema, included?.customFields).filter(
      (f) => !!f.baseCustomFieldGroupId
    ),
  };
}

const byPosition = (a: { position?: number | null }, b: { position?: number | null }) =>
  (a.position ?? 0) - (b.position ?? 0);

export const slotKey = (groupId: string | null | undefined, fieldId: string) =>
  `${groupId ?? ""}:${fieldId}`;

/** Pure assembly: tested on its own, fed by the three reads. */
export function assembleSlots(
  card: CardLightDetails,
  boardGroups: CustomFieldGroup[],
  boardFields: CustomField[],
  base: ProjectBaseFields | null
): Omit<CardCustomFields, "card"> {
  const values = new Map<string, string | null>();
  for (const v of card.customFieldValues) {
    values.set(slotKey(v.customFieldGroupId, v.customFieldId), v.content ?? null);
  }

  const groups: Array<{ g: CustomFieldGroup; scope: "board" | "card" }> = [
    ...[...boardGroups].sort(byPosition).map((g) => ({ g, scope: "board" as const })),
    // The card show only carries this card's own groups.
    ...[...card.customFieldGroups].sort(byPosition).map((g) => ({ g, scope: "card" as const })),
  ];
  const ownFields = [...card.customFields, ...boardFields];

  const slots: CustomFieldSlot[] = [];
  const seen = new Set<string>();
  let missingBase = false;

  for (const { g, scope } of groups) {
    let fields: CustomField[];
    let groupName = g.name ?? null;
    if (g.baseCustomFieldGroupId) {
      if (!base) {
        missingBase = true;
        continue;
      }
      fields = base.fields.filter(
        (f) => f.baseCustomFieldGroupId === g.baseCustomFieldGroupId
      );
      groupName = groupName ?? base.groupNames.get(g.baseCustomFieldGroupId) ?? null;
    } else {
      fields = ownFields.filter((f) => f.customFieldGroupId === g.id);
    }

    for (const f of [...fields].sort(byPosition)) {
      const key = slotKey(g.id, f.id);
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({
        groupId: g.id,
        group: groupName,
        scope,
        fieldId: f.id,
        field: f.name ?? null,
        content: values.get(key) ?? null,
      });
    }
  }

  const orphans = card.customFieldValues
    .filter((v) => !seen.has(slotKey(v.customFieldGroupId, v.customFieldId)))
    .map((v) => ({
      groupId: v.customFieldGroupId ?? null,
      fieldId: v.customFieldId,
      content: v.content ?? null,
    }));

  return {
    slots,
    orphans,
    ...(missingBase
      ? {
          incomplete:
            "a group comes from a project template whose fields could not be read",
        }
      : {}),
  };
}

/**
 * Every custom field slot of a card.
 *
 * `fresh: false` (reads) takes the board from the one-minute names cache and
 * never fails on it: a board that cannot be read costs the board-level fields
 * and sets `incomplete`. `fresh: true` (writes) reads the board again and lets
 * a failure propagate — "no such field" must never be said off a stale or
 * missing read.
 */
export async function getCardCustomFields(
  cardId: string,
  opts: { fresh: boolean; card?: CardLightDetails }
): Promise<CardCustomFields> {
  const card = opts.card ?? (await getCardLight({ cardId }));

  let board: BoardNames | null;
  if (opts.fresh) {
    board = await fetchBoardNames(card.card.boardId);
  } else {
    board = await getBoardNames(card.card.boardId);
  }

  const boardGroups = board?.customFieldGroups ?? [];
  const needsBase = [...boardGroups, ...card.customFieldGroups].some(
    (g) => !!g.baseCustomFieldGroupId
  );

  let base: ProjectBaseFields | null = null;
  let baseError: string | undefined;
  if (needsBase && board?.projectId) {
    try {
      base = await fetchProjectBaseFields(board.projectId);
    } catch (error) {
      if (opts.fresh) throw error;
      baseError = error instanceof Error ? error.message : String(error);
    }
  }

  const assembled = assembleSlots(card, boardGroups, board?.customFieldDefs ?? [], base);
  const incomplete = !board
    ? "the board could not be read, so its board-level fields are missing"
    : assembled.incomplete && baseError
      ? `${assembled.incomplete}: ${baseError}`
      : assembled.incomplete;

  return { card, ...assembled, ...(incomplete ? { incomplete } : {}) };
}

function valuePath(cardId: string, groupId: string, fieldId: string) {
  return `/api/cards/${cardId}/custom-field-values/customFieldGroupId:${groupId}:customFieldId:${fieldId}`;
}

export async function writeCustomFieldValue(
  cardId: string,
  groupId: string,
  fieldId: string,
  content: string
): Promise<unknown> {
  if (content.length > CUSTOM_FIELD_CONTENT_MAX) {
    throw new PlankaError(
      `content is ${content.length} characters; Planka accepts at most ${CUSTOM_FIELD_CONTENT_MAX}`,
      "VALIDATION_ERROR",
      400
    );
  }
  return plankaClient.patch<unknown>(valuePath(cardId, groupId, fieldId), { content });
}

export async function deleteCustomFieldValue(
  cardId: string,
  groupId: string,
  fieldId: string
): Promise<unknown> {
  return plankaClient.delete<unknown>(valuePath(cardId, groupId, fieldId));
}
