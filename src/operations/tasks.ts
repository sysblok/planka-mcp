/**
 * Task (checklist item) operations for PLANKA 2.0 API.
 *
 * PLANKA 2.0 introduced task-lists (checklists) as containers for tasks.
 * This module provides a convenience layer that auto-creates a default
 * task-list when adding tasks to a card that doesn't have one.
 */
import { plankaClient } from "../client.js";
import { Task, TaskList } from "../schemas/entities.js";
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  BatchCreateTasksSchema,
  CreateTaskInput,
  UpdateTaskInput,
  BatchCreateTasksInput,
} from "../schemas/requests.js";
import { TaskResponse, TaskListResponse } from "../schemas/responses.js";
import { getCard } from "./cards.js";

const DEFAULT_TASK_LIST_NAME = "Tasks";

/**
 * Get or create a default task-list for a card.
 * If the card has no task-lists, creates one called "Tasks".
 */
async function getOrCreateDefaultTaskList(cardId: string): Promise<TaskList> {
  // Fetch card to see existing task-lists
  const cardDetails = await getCard(cardId);

  // Check if there's an existing task-list
  if (cardDetails.taskLists && cardDetails.taskLists.length > 0) {
    // Return the first task-list (sorted by position)
    return cardDetails.taskLists.sort((a, b) => a.position - b.position)[0];
  }

  // Create a default task-list
  const response = await plankaClient.post<unknown>(
    `/api/cards/${cardId}/task-lists`,
    {
      name: DEFAULT_TASK_LIST_NAME,
      position: 65536,
    }
  );

  const parsed = TaskListResponse.parse(response);
  return parsed.item;
}

/**
 * Create a task-list on a card.
 */
export async function createTaskList(
  cardId: string,
  name: string,
  position?: number
): Promise<TaskList> {
  const response = await plankaClient.post<unknown>(
    `/api/cards/${cardId}/task-lists`,
    {
      name,
      position: position ?? 65536,
    }
  );

  const parsed = TaskListResponse.parse(response);
  return parsed.item;
}

/**
 * Create a single task on a card.
 * Automatically creates a default task-list if the card doesn't have one.
 */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const validated = CreateTaskSchema.parse(input);

  // Get or create a task-list for this card
  const taskList = await getOrCreateDefaultTaskList(validated.cardId);

  const response = await plankaClient.post<unknown>(
    `/api/task-lists/${taskList.id}/tasks`,
    {
      name: validated.name,
      position: validated.position,
    }
  );

  const parsed = TaskResponse.parse(response);
  return parsed.item;
}

/**
 * Create multiple tasks on a card.
 * Tasks are created in order with automatically calculated positions.
 * Automatically creates a default task-list if the card doesn't have one.
 */
export async function createTasks(input: BatchCreateTasksInput): Promise<Task[]> {
  const validated = BatchCreateTasksSchema.parse(input);

  // Get or create a task-list for this card
  const taskList = await getOrCreateDefaultTaskList(validated.cardId);

  const tasks: Task[] = [];
  let position = 65536;

  for (const taskInput of validated.tasks) {
    const response = await plankaClient.post<unknown>(
      `/api/task-lists/${taskList.id}/tasks`,
      {
        name: taskInput.name,
        position: taskInput.position ?? position,
      }
    );

    const parsed = TaskResponse.parse(response);
    tasks.push(parsed.item);
    position += 65536;
  }

  return tasks;
}

/**
 * Update a task's properties.
 */
export async function updateTask(
  taskId: string,
  input: UpdateTaskInput
): Promise<Task> {
  const validated = UpdateTaskSchema.parse(input);

  const response = await plankaClient.patch<unknown>(
    `/api/tasks/${taskId}`,
    validated
  );

  const parsed = TaskResponse.parse(response);
  return parsed.item;
}

/**
 * Delete a task.
 */
export async function deleteTask(taskId: string): Promise<void> {
  await plankaClient.delete(`/api/tasks/${taskId}`);
}

/**
 * Delete a task-list and all its tasks.
 */
export async function deleteTaskList(taskListId: string): Promise<void> {
  await plankaClient.delete(`/api/task-lists/${taskListId}`);
}
