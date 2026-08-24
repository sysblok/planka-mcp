/**
 * Label operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { withBoardId } from "./board-id.js";
import { parseInput } from "../errors.js";
import { Label, CardLabel } from "../schemas/entities.js";
import {
  AddLabelToCardSchema,
  AddLabelToCardInput,
  CreateLabelSchema,
  CreateLabelInput,
  LabelIdSchema,
  LabelIdInput,
  RemoveLabelFromCardSchema,
  RemoveLabelFromCardInput,
  SetCardLabelsSchema,
  SetCardLabelsInput,
  UpdateLabelParamsSchema,
  UpdateLabelParamsInput,
} from "../schemas/requests.js";
import { LabelResponse, CardLabelResponse } from "../schemas/responses.js";
import { getCard } from "./cards.js";

/**
 * Create a new label on a board.
 */
export async function createLabel(input: CreateLabelInput): Promise<Label> {
  const validated = parseInput(CreateLabelSchema, input);

  return withBoardId(validated.boardId, async (boardId) => {
    const response = await plankaClient.post<unknown>(
      `/api/boards/${boardId}/labels`,
      {
        name: validated.name,
        color: validated.color,
        position: validated.position,
      }
    );

    const parsed = LabelResponse.parse(response);
    return parsed.item;
  });
}

/**
 * Update a label's properties.
 */
export async function updateLabel(
  input: UpdateLabelParamsInput
): Promise<Label> {
  const { labelId, ...updates } = parseInput(UpdateLabelParamsSchema, input);

  const response = await plankaClient.patch<unknown>(
    `/api/labels/${labelId}`,
    updates
  );

  const parsed = LabelResponse.parse(response);
  return parsed.item;
}

/**
 * Delete a label.
 */
export async function deleteLabel(input: LabelIdInput): Promise<void> {
  const { labelId } = parseInput(LabelIdSchema, input);
  await plankaClient.delete(`/api/labels/${labelId}`);
}

/**
 * Add a label to a card.
 * Uses PLANKA 2.0 /card-labels endpoint.
 */
export async function addLabelToCard(input: AddLabelToCardInput): Promise<CardLabel> {
  const validated = parseInput(AddLabelToCardSchema, input);

  const response = await plankaClient.post<unknown>(
    `/api/cards/${validated.cardId}/card-labels`,
    {
      labelId: validated.labelId,
    }
  );

  const parsed = CardLabelResponse.parse(response);
  return parsed.item;
}

/**
 * Remove a label from a card.
 * Uses PLANKA 2.0 /card-labels endpoint.
 *
 * The path segment is PLANKA's criteria syntax — `labelId:<id>`, NOT the
 * junction record's own id. Deleting by cardLabelId answers 404 on 2.x and the
 * label silently stays on the card. Verified against PLANKA 2.x on 2026-08-02.
 */
export async function removeLabelFromCard(
  input: RemoveLabelFromCardInput
): Promise<void> {
  const { cardId, labelId } = parseInput(RemoveLabelFromCardSchema, input);
  await plankaClient.delete(
    `/api/cards/${cardId}/card-labels/labelId:${labelId}`
  );
}

/**
 * Outcome of setCardLabels, verified against the card's real state.
 *
 * Reporting the requested counts is not good enough: if a labelId does not
 * exist on the board, PLANKA answers 404 and the label silently never lands.
 * Callers need to know what is actually on the card, not what was asked for.
 */
export interface SetCardLabelsResult {
  /** Labels this call put on the card. */
  added: string[];
  /** Labels asked for that were already there. */
  alreadyPresent: string[];
  /** Labels this call took off the card. */
  removed: string[];
  /** Labels asked to be removed that were not on the card. */
  notPresent: string[];
  /** Labels asked for that are still NOT on the card — these are failures. */
  failed: Array<{ labelId: string; reason: string }>;
  /** Every label on the card once the operation finished. */
  finalLabelIds: string[];
}

/**
 * Set labels on a card (add some, remove others).
 *
 * Re-reads the card afterwards so the result reflects reality rather than the
 * request. Never reports success for a label that did not land.
 */
export async function setCardLabels(
  input: SetCardLabelsInput
): Promise<SetCardLabelsResult> {
  const { cardId, addLabelIds, removeLabelIds } = parseInput(
    SetCardLabelsSchema,
    input
  );
  const toAdd = addLabelIds ?? [];
  const toRemove = removeLabelIds ?? [];

  const before = await getCard({ cardId });
  const presentBefore = new Set(before.cardLabels.map((cl) => cl.labelId));

  const result: SetCardLabelsResult = {
    added: [],
    alreadyPresent: [],
    removed: [],
    notPresent: [],
    failed: [],
    finalLabelIds: [],
  };

  // Remove first, so a caller can swap a label for another in one call.
  for (const labelId of toRemove) {
    if (!presentBefore.has(labelId)) {
      result.notPresent.push(labelId);
      continue;
    }
    try {
      await removeLabelFromCard({ cardId, labelId });
    } catch (error) {
      result.failed.push({
        labelId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const labelId of toAdd) {
    if (presentBefore.has(labelId)) {
      result.alreadyPresent.push(labelId);
      continue;
    }
    try {
      await addLabelToCard({ cardId, labelId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "already on card" is not a failure — the desired state holds.
      if (message.toLowerCase().includes("already")) {
        result.alreadyPresent.push(labelId);
        continue;
      }
      result.failed.push({ labelId, reason: message });
    }
  }

  // Verify against the card itself: this is what makes the report trustworthy.
  const after = await getCard({ cardId });
  const presentAfter = new Set(after.cardLabels.map((cl) => cl.labelId));
  result.finalLabelIds = [...presentAfter];

  result.added = toAdd.filter(
    (id) => presentAfter.has(id) && !presentBefore.has(id)
  );
  result.removed = toRemove.filter(
    (id) => presentBefore.has(id) && !presentAfter.has(id)
  );

  // Anything requested that is still missing (or still there) is a failure,
  // even if the HTTP call did not throw.
  const known = new Set(result.failed.map((f) => f.labelId));
  for (const id of toAdd) {
    if (!presentAfter.has(id) && !known.has(id)) {
      result.failed.push({
        labelId: id,
        reason:
          "the label is still not on the card — check that this labelId belongs to the card's board",
      });
    }
  }
  for (const id of toRemove) {
    if (presentAfter.has(id) && !known.has(id)) {
      result.failed.push({
        labelId: id,
        reason: "the label is still on the card",
      });
    }
  }

  return result;
}
