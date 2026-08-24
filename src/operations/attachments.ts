/**
 * Attachment operations for PLANKA API.
 *
 * Upload: multipart POST /api/cards/:id/attachments — both `type=file` and
 * `name` are REQUIRED in PLANKA 2.0 (without `name` it answers 400
 * E_MISSING_OR_INVALID_PARAMS, which reads like a permission problem).
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { plankaClient } from "../client.js";
import { parseInput } from "../errors.js";
import { Attachment } from "../schemas/entities.js";
import {
  AttachmentResponse,
  CardIncludedSchema,
  CardResponse,
} from "../schemas/responses.js";
import {
  AttachmentIdSchema,
  AttachmentIdInput,
  CardIdSchema,
  CardIdInput,
  UploadAttachmentSchema,
  UploadAttachmentInput,
} from "../schemas/requests.js";

/** MIME by extension for the usual uploads (screenshots, logs, docs). */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
};

export function guessMimeType(input: { filePath: string }): string {
  return (
    MIME_BY_EXT[extname(input.filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

/**
 * Get all attachments on a card (from the card endpoint's `included`).
 */
export async function getAttachmentsForCard(
  input: CardIdInput
): Promise<Attachment[]> {
  const { cardId } = parseInput(CardIdSchema, input);
  const response = await plankaClient.get<unknown>(`/api/cards/${cardId}`);
  CardResponse.parse(response); // validates the overall shape
  const included = CardIncludedSchema.parse(
    (response as Record<string, unknown>).included || {}
  );
  return included.attachments || [];
}

/**
 * Upload a local file as a card attachment.
 */
export async function uploadAttachment(
  input: UploadAttachmentInput
): Promise<Attachment> {
  const { cardId, filePath, name } = parseInput(UploadAttachmentSchema, input);

  const bytes = await readFile(filePath);
  const fileName = name ?? basename(filePath);
  const mimeType = guessMimeType({ filePath });

  const form = new FormData();
  form.append("type", "file"); // required in 2.0
  form.append("name", fileName); // required in 2.0
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    fileName
  );

  const response = await plankaClient.postMultipart<unknown>(
    `/api/cards/${cardId}/attachments`,
    form
  );
  return AttachmentResponse.parse(response).item;
}

/**
 * Delete an attachment.
 */
export async function deleteAttachment(
  input: AttachmentIdInput
): Promise<void> {
  const { attachmentId } = parseInput(AttachmentIdSchema, input);
  await plankaClient.delete(`/api/attachments/${attachmentId}`);
}

/**
 * An attachment's download URL. 2.0 exposes it as data.url; when it is
 * missing, fall back to the /attachments/:id/download/:name pattern.
 */
export function attachmentDownloadUrl(input: {
  attachment: Attachment;
}): string {
  const { attachment } = input;
  return (
    attachment.data?.url ??
    attachment.url ??
    `/attachments/${attachment.id}/download/${encodeURIComponent(attachment.name)}`
  );
}

/**
 * Download an attachment's binary content.
 */
export async function downloadAttachment(input: {
  attachment: Attachment;
}): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const { attachment } = input;
  const { bytes, mimeType } = await plankaClient.getBinary(
    attachmentDownloadUrl({ attachment })
  );
  return {
    bytes,
    mimeType:
      attachment.data?.mimeType ??
      mimeType ??
      guessMimeType({ filePath: attachment.name }),
  };
}
