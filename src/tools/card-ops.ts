/**
 * Card operations Planka has that this server did not expose: duplicating a
 * card, archiving one, and emptying a column into another.
 *
 * All three are verified the same way the rest of the server is: the write is
 * sent, the entity is read back, and the report describes the re-read.
 */
import { duplicateCard } from "../operations/duplicate.js";
import { getCardBrief } from "../operations/card-brief.js";
import {
  getBoardSystemLists,
  moveCardToList,
  noArchiveList,
} from "../operations/archive.js";
import {
  bulkMoveClosedListToArchive,
  moveCardsOneByOne,
  readListState,
} from "../operations/lists.js";
import { verifiedWrite, writeResult } from "../operations/verify.js";
import { assertBoardAllowed, assertListWritable } from "../config/policy.js";
import { PlankaError } from "../errors.js";

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

function catchPlanka(error: unknown) {
  if (error instanceof PlankaError) return errorResult(error.message);
  throw error;
}

/**
 * Tool: planka_duplicate_card
 */
export const duplicateCardTool = {
  name: "planka_duplicate_card",
  description:
    "Copy a card with its tasks, labels and members (attachments are not copied). Lands in the " +
    "same column unless listId says otherwise. Re-reads the copy and reports what it carries.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: { type: "string", description: "The card to copy" },
      listId: {
        type: "string",
        description: "Column for the copy. Defaults to the original's column.",
      },
      boardId: {
        type: "string",
        description: "Board for the copy, when copying across boards. Requires listId.",
      },
      name: {
        type: "string",
        description:
          "Name for the copy. Without it Planka appends its own suffix to the original name.",
      },
      position: { type: "number", description: "Position in the target column" },
    },
    required: ["cardId"],
  },
  handler: async (params: {
    cardId: string;
    listId?: string;
    boardId?: string;
    name?: string;
    position?: number;
  }) => {
    try {
      if (params.boardId && !params.listId) {
        return errorResult(
          "boardId without listId: a copy sent to another board needs the column it lands in."
        );
      }

      const written = await verifiedWrite({
        write: () => duplicateCard(params),
        reread: (copy) => getCardBrief({ cardId: copy.id }),
        landed: (after, copy) => {
          if (after.card.id !== copy.id) return false;
          if (params.listId && after.card.listId !== params.listId) return false;
          if (params.name !== undefined && after.card.name !== params.name) return false;
          return true;
        },
      });

      const after = written.after;
      return writeResult(
        {
          card: {
            id: written.result.id,
            name: after?.card.name ?? written.result.name,
            listId: after?.card.listId ?? written.result.listId,
            boardId: after?.card.boardId ?? written.result.boardId,
          },
          sourceCardId: params.cardId,
          copied: {
            tasks: after?.counts.tasks ?? 0,
            labels: after?.counts.labels ?? 0,
            members: after?.counts.members ?? 0,
            attachments: after?.counts.attachments ?? 0,
          },
        },
        written
      );
    } catch (error) {
      return catchPlanka(error);
    }
  },
};

/**
 * Tool: planka_archive_card
 */
export const archiveCardTool = {
  name: "planka_archive_card",
  description:
    "Archive a card (Planka's hidden archive column) or bring it back with restoreToListId. " +
    "Archiving hides the card from the board without deleting it; verified by re-reading its column.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: { type: "string", description: "The card ID" },
      restoreToListId: {
        type: "string",
        description:
          "Un-archive instead: move the card into this column. The card's previous column is reported when archiving.",
      },
      position: {
        type: "number",
        description: "Position in the column when restoring. Defaults to the end.",
      },
    },
    required: ["cardId"],
  },
  handler: async (params: {
    cardId: string;
    restoreToListId?: string;
    position?: number;
  }) => {
    try {
      const before = await getCardBrief({ cardId: params.cardId });
      const boardId = before.card.boardId;

      // --- restore ---------------------------------------------------------
      if (params.restoreToListId) {
        assertListWritable(params.restoreToListId, undefined, "restore cards into");

        const written = await verifiedWrite({
          write: () =>
            moveCardToList({
              cardId: params.cardId,
              listId: params.restoreToListId!,
              // An archived card has position null and Planka refuses a PATCH
              // without one, so a restore always carries a position.
              position: params.position ?? 65536,
            }),
          reread: () => getCardBrief({ cardId: params.cardId }),
          landed: (after) => after.card.listId === params.restoreToListId,
        });

        return writeResult(
          {
            card: {
              id: params.cardId,
              name: written.after?.card.name ?? before.card.name,
              listId: written.after?.card.listId ?? before.card.listId,
            },
            archived: false,
            restoredTo: params.restoreToListId,
            previousListId: before.card.listId,
          },
          written
        );
      }

      // --- archive ---------------------------------------------------------
      const system = await getBoardSystemLists(boardId);
      if (!system.archiveListId) throw noArchiveList(boardId);
      assertListWritable(system.archiveListId, undefined, "archive cards into");

      if (before.card.listId === system.archiveListId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                verified: true,
                card: {
                  id: before.card.id,
                  name: before.card.name,
                  listId: before.card.listId,
                },
                archived: true,
                alreadyArchived: true,
                archiveListId: system.archiveListId,
                previousListId: before.card.prevListId ?? null,
                message:
                  "The card was already in the archive. Pass restoreToListId to bring it back" +
                  (before.card.prevListId
                    ? ` (it came from list ${before.card.prevListId}).`
                    : "."),
              }),
            },
          ],
        };
      }

      const written = await verifiedWrite({
        write: () =>
          moveCardToList({ cardId: params.cardId, listId: system.archiveListId! }),
        reread: () => getCardBrief({ cardId: params.cardId }),
        // isClosed does NOT flip on archive (verified on 2.2.1), so the column
        // is the only honest proof.
        landed: (after) =>
          after.card.listId === system.archiveListId &&
          after.card.listId !== before.card.listId,
      });

      return writeResult(
        {
          card: {
            id: before.card.id,
            name: written.after?.card.name ?? before.card.name,
            listId: written.after?.card.listId ?? system.archiveListId,
          },
          archived: written.verified,
          archiveListId: system.archiveListId,
          previousListId: before.card.listId,
          message: written.verified
            ? `Card archived. Restore it with restoreToListId: "${before.card.listId}".`
            : "The card does not read as archived.",
        },
        written
      );
    } catch (error) {
      return catchPlanka(error);
    }
  },
};

/**
 * Tool: planka_move_list_cards
 *
 * Planka's own bulk endpoint looks like the implementation of this tool and is
 * not: it only archives a whole `closed` column, and answers 403 "Not enough
 * rights" for anything else (see `bulkMoveClosedListToArchive`). So the tool
 * uses it where it applies and moves card by card everywhere else — the
 * promise to the caller is the same either way, and `strategy` says which ran.
 */
export const moveListCardsTool = {
  name: "planka_move_list_cards",
  description:
    "Move EVERY card of one column into another. Counts both columns before and after; verified " +
    "is false when the numbers do not add up. Reports partial moves rather than a smaller success.",
  inputSchema: {
    type: "object" as const,
    properties: {
      fromListId: { type: "string", description: "Column to empty" },
      toListId: { type: "string", description: "Column that receives the cards" },
      boardId: {
        type: "string",
        description: "Board both columns belong to. Checked against the allowlist when given.",
      },
    },
    required: ["fromListId", "toListId"],
  },
  handler: async (params: {
    fromListId: string;
    toListId: string;
    boardId?: string;
  }) => {
    try {
      if (params.fromListId === params.toListId) {
        return errorResult(
          "fromListId and toListId are the same column: nothing would move."
        );
      }
      if (params.boardId) assertBoardAllowed(params.boardId);
      assertListWritable(params.toListId, undefined, "move cards into");
      assertListWritable(params.fromListId, undefined, "move cards out of");

      const from = await readListState(params.fromListId);
      if (!from) {
        return errorResult(
          `List ${params.fromListId} cannot be read. Planka's hidden archive and trash lists ` +
            `answer 404 here, and so does a list id that does not exist.`
        );
      }

      // The destination may legitimately be unreadable: the archive list is.
      const to = await readListState(params.toListId);
      const toBefore = to?.count ?? null;

      if (from.count === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                verified: true,
                moved: 0,
                fromRemaining: 0,
                toTotal: toBefore,
                message: `List ${params.fromListId} is already empty; nothing was moved.`,
              }),
            },
          ],
        };
      }

      // Planka's bulk call only accepts closed -> archive. Everywhere else it
      // answers 403, so it is not even attempted. The board show that resolves
      // the archive id is expensive, so it is only read when the destination
      // could BE the archive — an unreadable list — and the source is closed.
      let canBulk = false;
      if (from.type === "closed" && to === null && from.boardId) {
        const { archiveListId } = await getBoardSystemLists(from.boardId);
        canBulk = archiveListId === params.toListId;
      }

      const cards = from.cardIds.map((id) => ({
        id,
        position: from.positions.get(id) ?? null,
      }));

      let failed: Array<{ cardId: string; reason: string }> = [];
      const written = await verifiedWrite({
        write: async () => {
          if (canBulk) {
            await bulkMoveClosedListToArchive({
              fromListId: params.fromListId,
              toListId: params.toListId,
            });
            return "bulk" as const;
          }
          failed = await moveCardsOneByOne({ cards, toListId: params.toListId });
          return "perCard" as const;
        },
        reread: async () => ({
          from: (await readListState(params.fromListId))?.count ?? null,
          to: (await readListState(params.toListId))?.count ?? null,
        }),
        landed: (after) => {
          if (after.from !== 0) return false;
          // An unreadable destination (the archive) cannot be counted; an empty
          // source plus no failed PATCH is the whole proof available.
          if (after.to === null || toBefore === null) return failed.length === 0;
          return after.to === toBefore + from.count;
        },
      });

      const fromAfter = written.after?.from ?? from.count;
      const toAfter = written.after?.to ?? toBefore;

      return writeResult(
        {
          fromListId: params.fromListId,
          toListId: params.toListId,
          strategy: written.result,
          moved: from.count - (fromAfter ?? from.count),
          fromRemaining: fromAfter,
          toTotal: toAfter,
          ...(toBefore === null
            ? {
                toCountUnavailable:
                  "the destination list cannot be read (Planka hides archive and trash), so only the source was counted",
              }
            : { expectedTotal: toBefore + from.count }),
          ...(failed.length ? { failed } : {}),
        },
        written
      );
    } catch (error) {
      return catchPlanka(error);
    }
  },
};

export const cardOpsTools = [duplicateCardTool, archiveCardTool, moveListCardsTool];
