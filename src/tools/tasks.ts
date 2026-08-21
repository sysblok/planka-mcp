/**
 * Task tools for PLANKA MCP server.
 */
import { createTasks, updateTask, deleteTask } from "../operations/tasks.js";
import { PlankaError } from "../errors.js";

/**
 * Tool: planka_create_tasks
 * Add one or more tasks (checklist items) to a card.
 */
export const createTasksTool = {
  name: "planka_create_tasks",
  description: "Add one or more tasks (checklist items) to a card.",
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
      const tasks = await createTasks({
        cardId: params.cardId,
        tasks: params.tasks.map((name) => ({ name })),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                tasksCreated: tasks.length,
                tasks: tasks.map((t) => ({
                  id: t.id,
                  name: t.name,
                  isCompleted: t.isCompleted,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
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
  description: "Update a task's name or completion status.",
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: {
        type: "string",
        description: "The task ID",
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
    name?: string;
    isCompleted?: boolean;
  }) => {
    try {
      const { taskId, ...updates } = params;

      // Only include defined fields
      const filteredUpdates: Record<string, unknown> = {};
      if (updates.name !== undefined) filteredUpdates.name = updates.name;
      if (updates.isCompleted !== undefined)
        filteredUpdates.isCompleted = updates.isCompleted;

      const task = await updateTask(taskId, filteredUpdates);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                task: {
                  id: task.id,
                  name: task.name,
                  isCompleted: task.isCompleted,
                },
              },
              null,
              2
            ),
          },
        ],
      };
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
  description: "Delete a task from a card.",
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: {
        type: "string",
        description: "The task ID to delete",
      },
    },
    required: ["taskId"],
  },
  handler: async (params: { taskId: string }) => {
    try {
      await deleteTask(params.taskId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                message: `Task ${params.taskId} deleted`,
              },
              null,
              2
            ),
          },
        ],
      };
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
