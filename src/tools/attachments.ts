/**
 * Attachment tools for PLANKA MCP server.
 */
import {
  getAttachmentsForCard,
  uploadAttachment,
  deleteAttachment,
  downloadAttachment,
  attachmentDownloadUrl,
} from "../operations/attachments.js";
import { Attachment } from "../schemas/entities.js";
import { verifiedDelete, writeResult } from "../operations/verify.js";
import { PlankaError } from "../errors.js";

/** Cap for returning images inline to the model (base64 inflates ~33%). */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Cap for text attachments returned inline. */
const MAX_TEXT_BYTES = 50 * 1024;

function summarize(attachment: Attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    mimeType: attachment.data?.mimeType ?? undefined,
    size: attachment.data?.size ?? undefined,
    url: attachmentDownloadUrl({ attachment }),
    createdAt: attachment.createdAt,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Tool: planka_add_attachment
 */
export const addAttachmentTool = {
  name: "planka_add_attachment",
  description:
    "Upload a local file (screenshot, log, doc) onto a card.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: { type: "string", description: "The card ID" },
      filePath: {
        type: "string",
        description: "Absolute path of the local file to upload",
      },
      name: {
        type: "string",
        description:
          "Attachment name shown in Planka (defaults to the file's basename). Use descriptive names: antes-…, despues-…, error-consola-…",
      },
    },
    required: ["cardId", "filePath"],
  },
  handler: async (params: {
    cardId: string;
    filePath: string;
    name?: string;
  }) => {
    try {
      const attachment = await uploadAttachment({
        cardId: params.cardId,
        filePath: params.filePath,
        name: params.name,
      });

      // Verify by re-reading the card's attachments: Planka sometimes answers
      // 200 without persisting, and a write is not done until a read says so.
      const after = await getAttachmentsForCard({ cardId: params.cardId });
      const verified = after.some((a) => a.id === attachment.id);

      return writeResult(
        { cardId: params.cardId, attachment: summarize(attachment) },
        { verified }
      );
    } catch (error) {
      if (error instanceof PlankaError) return errorResult(error.message);
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return errorResult(`File not found: ${params.filePath}`);
      }
      throw error;
    }
  },
};

/**
 * Tool: planka_get_attachments
 */
export const getAttachmentsTool = {
  name: "planka_get_attachments",
  description:
    "Attachments on a card: id, name, mimeType, size, download URL.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: { type: "string", description: "The card ID" },
    },
    required: ["cardId"],
  },
  handler: async (params: { cardId: string }) => {
    try {
      const attachments = await getAttachmentsForCard({
        cardId: params.cardId,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                cardId: params.cardId,
                attachmentCount: attachments.length,
                attachments: attachments.map(summarize),
              }
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof PlankaError) return errorResult(error.message);
      throw error;
    }
  },
};

/**
 * Tool: planka_view_attachment
 * Images come back as MCP "image" content (the model actually SEES them);
 * text comes back inline; anything else returns metadata + URL.
 */
export const viewAttachmentTool = {
  name: "planka_view_attachment",
  description:
    "An attachment's content: images come back viewable, text inline, anything else as metadata only.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: { type: "string", description: "The card ID" },
      attachmentId: {
        type: "string",
        description:
          "Attachment ID (from planka_get_attachments). If omitted and the card has exactly one attachment, that one is used.",
      },
    },
    required: ["cardId"],
  },
  handler: async (params: { cardId: string; attachmentId?: string }) => {
    try {
      const attachments = await getAttachmentsForCard({
        cardId: params.cardId,
      });
      let attachment: Attachment | undefined;
      if (params.attachmentId) {
        attachment = attachments.find((a) => a.id === params.attachmentId);
        if (!attachment) {
          return errorResult(
            `Attachment ${params.attachmentId} not found on card ${params.cardId}. Available: ${attachments.map((a) => `${a.id} (${a.name})`).join(", ") || "none"}`
          );
        }
      } else if (attachments.length === 1) {
        attachment = attachments[0];
      } else {
        return errorResult(
          `Card has ${attachments.length} attachments — pass attachmentId. Available: ${attachments.map((a) => `${a.id} (${a.name})`).join(", ") || "none"}`
        );
      }

      const { bytes, mimeType } = await downloadAttachment({ attachment });

      if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") {
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return errorResult(
            `Image too large to view inline (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB > 3 MB). Download it instead: ${attachmentDownloadUrl({ attachment })}`
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Attachment "${attachment.name}" (${mimeType}, ${(bytes.byteLength / 1024).toFixed(0)} KB):`,
            },
            {
              type: "image" as const,
              data: Buffer.from(bytes).toString("base64"),
              mimeType,
            },
          ],
        };
      }

      const isTexty =
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "image/svg+xml";
      if (isTexty) {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.slice(0, MAX_TEXT_BYTES)
        );
        const truncated = bytes.byteLength > MAX_TEXT_BYTES;
        return {
          content: [
            {
              type: "text" as const,
              text: `Attachment "${attachment.name}" (${mimeType})${truncated ? " [truncated to 50KB]" : ""}:\n\n${text}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Binary attachment (${mimeType}) — cannot render inline`,
                attachment: summarize(attachment),
              }
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof PlankaError) return errorResult(error.message);
      throw error;
    }
  },
};

/**
 * Tool: planka_delete_attachment
 */
export const deleteAttachmentTool = {
  name: "planka_delete_attachment",
  description:
    "Delete an attachment. Confirmed by re-reading the card's attachments.",
  inputSchema: {
    type: "object" as const,
    properties: {
      attachmentId: { type: "string", description: "The attachment ID" },
      cardId: {
        type: "string",
        description:
          "The attachment's card. Optional — Planka usually echoes it on delete; it is what makes the deletion verifiable.",
      },
    },
    required: ["attachmentId"],
  },
  handler: async (params: { attachmentId: string; cardId?: string }) => {
    try {
      const deleted = await verifiedDelete({
        del: () => deleteAttachment({ attachmentId: params.attachmentId }),
        confirmGone: async (attachment) => {
          // The delete body carries the cardId; the param is the fallback.
          const cardId = params.cardId ?? attachment?.cardId;
          if (!cardId) return null;
          const after = await getAttachmentsForCard({ cardId });
          return !after.some((a) => a.id === params.attachmentId);
        },
        unknownReason:
          "Planka did not echo the deleted attachment and no cardId was passed, so the delete could not be confirmed",
      });

      return writeResult(
        {
          attachmentId: params.attachmentId,
          ...(params.cardId ?? deleted.result?.cardId
            ? { cardId: params.cardId ?? deleted.result?.cardId }
            : {}),
          message: deleted.verified
            ? `Attachment ${params.attachmentId} deleted`
            : `Attachment ${params.attachmentId} delete not confirmed`,
        },
        deleted
      );
    } catch (error) {
      if (error instanceof PlankaError) return errorResult(error.message);
      throw error;
    }
  },
};

export const attachmentTools = [
  addAttachmentTool,
  getAttachmentsTool,
  viewAttachmentTool,
  deleteAttachmentTool,
];
