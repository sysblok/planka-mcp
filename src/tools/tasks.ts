/**
 * Task tools for PLANKA MCP server.
 *
 * Tasks have no GET of their own in Planka 2.x: they are only visible through
 * their card. So verification here needs a `cardId`; without it the tool says
 * so instead of claiming success.
 */
import { createTasks, updateTask, deleteTask } from "../operations/tasks.js";
import { getCardLight } from "../operations/cards.js";
import { UpdateTaskParamsInput } from "../schemas/requests.js";
import {
  nothingToDo,
  verifiedDelete,
  verifiedWrite,
  writeResult,
} from "../operations/verify.js";
import { PlankaError } from "../errors.js";

const NO_CARD_ID =
  "pass cardId to verify: Planka has no GET for a single task, so the card is the only place it can be re-read";

/**
 * Tool: planka_create_tasks
 * Add one or more tasks (checklist items) to a card.
 */
export const createTasksTool = {
  name: "planka_create_tasks",
  description:
    "Add tasks (checklist items) to a card. Reports the tasks that actually landed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cardId: {
        type: "string",
        description: "The card ID",
      },
      tasks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Task names to create",
      },
    },
    required: ["cardId", "tasks"],
  },
  handler: async (params: { cardId: string; tasks: string[] }) => {
    try {
      const written = await verifiedWrite({
        write: () =>
          createTasks({
            cardId: params.cardId,
            tasks: params.tasks.map((name) => ({ name })),
          }),
        reread: () => getCardLight({ cardId: params.cardId }),
        landed: (after, tasks) =>
          tasks.length === params.tasks.length &&
          tasks.every((t) => after.tasks.some((x) => x.id === t.id)),
      });

      const after = written.after;
      const onCard = after
        ? written.result.filter((t) => after.tasks.some((x) => x.id === t.id))
        : [];

      return writeResult(
        {
          cardId: params.cardId,
          tasksRequested: params.tasks.length,
          tasksCreated: after ? onCard.length : 0,
          tasks: (after ? onCard : written.result).map((t) => ({
            id: t.id,
            name: t.name,
            isCompleted: t.isCompleted,
          })),
        },
        written
      );
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
};

/**
 * Tool: planka_update_task
 * Update a task's name or completion status.
 */
export const updateTaskTool = {
  name: "planka_update_task",
  description:
    "Update a task's name or completion. Pass cardId to have it verified.",
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: {
        type: "string",
        description: "The task ID",
      },
      cardId: {
        type: "string",
        description: "The task's card. Without it the change cannot be verified.",
      },
      name: {
        type: "string",
        description: "New task name",
      },
      isCompleted: {
        type: "boolean",
        description: "Mark as complete/incomplete",
      },
    },
    required: ["taskId"],
  },
  handler: async (params: {
    taskId: string;
    cardId?: string;
    name?: string;
    isCompleted?: boolean;
  }) => {
    try {
      const patch: UpdateTaskParamsInput = { taskId: params.taskId };
      if (params.name !== undefined) patch.name = params.name;
      if (params.isCompleted !== undefined)
        patch.isCompleted = params.isCompleted;

      if (Object.keys(patch).length === 1) {
        return nothingToDo("name, isCompleted");
      }

      const cardId = params.cardId;
      if (!cardId) {
        const task = await updateTask(patch);
        return writeResult(
          {
            task: {
              id: task.id,
              name: task.name,
              isCompleted: task.isCompleted,
            },
          },
          { verified: false, verificationUnavailable: NO_CARD_ID }
        );
      }

      const mismatches = (after: { tasks: Array<{ id: string; name: string; isCompleted: boolean }> }) => {
        const task = after.tasks.find((t) => t.id === params.taskId);
        if (!task) return ["task not found on the card"];
        const bad: string[] = [];
        if (patch.name !== undefined && task.name !== patch.name)
          bad.push("name");
        if (
          patch.isCompleted !== undefined &&
          task.isCompleted !== patch.isCompleted
        )
          bad.push("isCompleted");
        return bad;
      };

      const written = await verifiedWrite({
        write: () => updateTask(patch),
        reread: () => getCardLight({ cardId }),
        landed: (after) => mismatches(after).length === 0,
      });

      const onCard = written.after?.tasks.find((t) => t.id === params.taskId);
      const notLanded = written.after ? mismatches(written.after) : [];

      return writeResult(
        {
          cardId,
          task: {
            id: written.result.id,
            name: onCard?.name ?? written.result.name,
            isCompleted: onCard?.isCompleted ?? written.result.isCompleted,
          },
          ...(notLanded.length > 0 ? { notLanded } : {}),
        },
        written
      );
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
};

/**
 * Tool: planka_delete_task
 * Delete a task from a card.
 */
export const deleteTaskTool = {
  name: "planka_delete_task",
  description:
    "Delete a task. Pass cardId to have it verified.",
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: {
        type: "string",
        description: "The task ID to delete",
      },
      cardId: {
        type: "string",
        description: "The task's card. Without it the deletion cannot be verified.",
      },
    },
    required: ["taskId"],
  },
  handler: async (params: { taskId: string; cardId?: string }) => {
    try {
      const cardId = params.cardId;

      const deleted = await verifiedDelete({
        del: () => deleteTask({ taskId: params.taskId }),
        confirmGone: async () => {
          if (!cardId) return null;
          const after = await getCardLight({ cardId });
          return !after.tasks.some((t) => t.id === params.taskId);
        },
        unknownReason: NO_CARD_ID,
      });

      return writeResult(
        {
          taskId: params.taskId,
          ...(cardId ? { cardId } : {}),
          message: deleted.verified
            ? `Task ${params.taskId} deleted`
            : `Task ${params.taskId} delete not confirmed`,
        },
        deleted
      );
    } catch (error) {
      if (error instanceof PlankaError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
      throw error;
    }
  },
};

export const taskTools = [createTasksTool, updateTaskTool, deleteTaskTool];
