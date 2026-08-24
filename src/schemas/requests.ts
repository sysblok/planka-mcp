/**
 * Input schemas for PLANKA API operations.
 *
 * Every operation takes ONE object and validates it here, identifiers
 * included. Field names match the MCP tools' inputSchema (`cardId`, `listId`,
 * `boardId`, …) so a Zod error path points straight at the argument the model
 * sent.
 */
import { z } from "zod";
import { CardTypeSchema, LabelColorSchema, ListTypeSchema } from "./entities.js";

/** Required identifier; the field name travels inside the error message. */
const requiredId = (field: string) =>
  z.string().min(1, `${field} is required and cannot be empty`);

// Identifier-only inputs (get / delete / list by parent)
export const CardIdSchema = z.object({ cardId: requiredId("cardId") });
export type CardIdInput = z.input<typeof CardIdSchema>;

export const BoardIdSchema = z.object({ boardId: requiredId("boardId") });
export type BoardIdInput = z.input<typeof BoardIdSchema>;

export const ListIdSchema = z.object({ listId: requiredId("listId") });
export type ListIdInput = z.input<typeof ListIdSchema>;

export const LabelIdSchema = z.object({ labelId: requiredId("labelId") });
export type LabelIdInput = z.input<typeof LabelIdSchema>;

export const CommentIdSchema = z.object({ commentId: requiredId("commentId") });
export type CommentIdInput = z.input<typeof CommentIdSchema>;

export const TaskIdSchema = z.object({ taskId: requiredId("taskId") });
export type TaskIdInput = z.input<typeof TaskIdSchema>;

export const TaskListIdSchema = z.object({
  taskListId: requiredId("taskListId"),
});
export type TaskListIdInput = z.input<typeof TaskListIdSchema>;

export const AttachmentIdSchema = z.object({
  attachmentId: requiredId("attachmentId"),
});
export type AttachmentIdInput = z.input<typeof AttachmentIdSchema>;

// Card requests
export const CreateCardSchema = z.object({
  listId: z.string(),
  name: z.string().min(1, "Card name required"),
  description: z.string().optional(),
  position: z.number().optional().default(65536),
  type: CardTypeSchema.optional().default("project"), // Required for PLANKA 2.0
  dueDate: z.string().optional(),
});
export type CreateCardInput = z.input<typeof CreateCardSchema>;

export const UpdateCardSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  isCompleted: z.boolean().optional(),
  listId: z.string().optional(), // For moving cards
  boardId: z.string().optional(), // For moving across boards
  position: z.number().optional(),
});
export type UpdateCardInput = z.input<typeof UpdateCardSchema>;

export const UpdateCardParamsSchema = UpdateCardSchema.extend({
  cardId: requiredId("cardId"),
});
export type UpdateCardParamsInput = z.input<typeof UpdateCardParamsSchema>;

export const MoveCardSchema = z.object({
  cardId: z.string(),
  listId: z.string(),
  position: z.number().optional().default(65536),
  boardId: z.string().optional(),
});
export type MoveCardInput = z.input<typeof MoveCardSchema>;

// Task requests
export const CreateTaskSchema = z.object({
  cardId: z.string(),
  name: z.string().min(1, "Task name required"),
  position: z.number().optional().default(65536),
});
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.object({
  name: z.string().min(1).optional(),
  isCompleted: z.boolean().optional(),
  position: z.number().optional(),
});
export type UpdateTaskInput = z.input<typeof UpdateTaskSchema>;

export const UpdateTaskParamsSchema = UpdateTaskSchema.extend({
  taskId: requiredId("taskId"),
});
export type UpdateTaskParamsInput = z.input<typeof UpdateTaskParamsSchema>;

export const BatchCreateTasksSchema = z.object({
  cardId: z.string(),
  tasks: z.array(
    z.object({
      name: z.string().min(1),
      position: z.number().optional(),
    })
  ),
});
export type BatchCreateTasksInput = z.input<typeof BatchCreateTasksSchema>;

export const CreateTaskListSchema = z.object({
  cardId: requiredId("cardId"),
  name: z.string().min(1, "Task-list name required"),
  position: z.number().optional().default(65536),
});
export type CreateTaskListInput = z.input<typeof CreateTaskListSchema>;

// Label requests
export const CreateLabelSchema = z.object({
  boardId: z.string(),
  name: z.string().min(1, "Label name required"),
  color: LabelColorSchema,
  position: z.number().optional().default(65536),
});
export type CreateLabelInput = z.input<typeof CreateLabelSchema>;

export const UpdateLabelSchema = z.object({
  name: z.string().min(1).optional(),
  color: LabelColorSchema.optional(),
  position: z.number().optional(),
});
export type UpdateLabelInput = z.input<typeof UpdateLabelSchema>;

export const UpdateLabelParamsSchema = UpdateLabelSchema.extend({
  labelId: requiredId("labelId"),
});
export type UpdateLabelParamsInput = z.input<typeof UpdateLabelParamsSchema>;

export const AddLabelToCardSchema = z.object({
  cardId: z.string(),
  labelId: z.string(),
});
export type AddLabelToCardInput = z.input<typeof AddLabelToCardSchema>;

export const RemoveLabelFromCardSchema = z.object({
  cardId: z.string(),
  labelId: z.string(),
});
export type RemoveLabelFromCardInput = z.input<typeof RemoveLabelFromCardSchema>;

export const SetCardLabelsSchema = z.object({
  cardId: requiredId("cardId"),
  addLabelIds: z.array(z.string().min(1)).optional(),
  removeLabelIds: z.array(z.string().min(1)).optional(),
});
export type SetCardLabelsInput = z.input<typeof SetCardLabelsSchema>;

// Comment requests
export const CreateCommentSchema = z.object({
  cardId: z.string(),
  text: z.string().min(1, "Comment text required"),
});
export type CreateCommentInput = z.input<typeof CreateCommentSchema>;

export const UpdateCommentSchema = z.object({
  text: z.string().min(1),
});
export type UpdateCommentInput = z.input<typeof UpdateCommentSchema>;

export const UpdateCommentParamsSchema = UpdateCommentSchema.extend({
  commentId: requiredId("commentId"),
});
export type UpdateCommentParamsInput = z.input<
  typeof UpdateCommentParamsSchema
>;

// List requests
export const CreateListSchema = z.object({
  boardId: z.string(),
  name: z.string().min(1, "List name required"),
  position: z.number().optional().default(65536),
  type: ListTypeSchema.optional().default("active"),
});
export type CreateListInput = z.input<typeof CreateListSchema>;

export const UpdateListSchema = z.object({
  name: z.string().min(1).optional(),
  position: z.number().optional(),
  type: ListTypeSchema.optional(),
});
export type UpdateListInput = z.input<typeof UpdateListSchema>;

export const UpdateListParamsSchema = UpdateListSchema.extend({
  listId: requiredId("listId"),
});
export type UpdateListParamsInput = z.input<typeof UpdateListParamsSchema>;

// Board requests
export const GetCardsForListSchema = z.object({
  boardId: requiredId("boardId"),
  listId: requiredId("listId"),
});
export type GetCardsForListInput = z.input<typeof GetCardsForListSchema>;

// Attachment requests
export const UploadAttachmentSchema = z.object({
  cardId: requiredId("cardId"),
  filePath: z.string().min(1, "filePath is required"),
  name: z.string().min(1).optional(),
});
export type UploadAttachmentInput = z.input<typeof UploadAttachmentSchema>;

// Project requests
export const GetStructureSchema = z.object({
  projectId: z.string().min(1).optional(),
});
export type GetStructureInput = z.input<typeof GetStructureSchema>;
