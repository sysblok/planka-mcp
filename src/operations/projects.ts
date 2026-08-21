/**
 * Project operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { Project, Board, List } from "../schemas/entities.js";
import { ProjectsResponse, ProjectsIncludedSchema } from "../schemas/responses.js";
import { z } from "zod";

/**
 * Full project structure with boards and lists.
 */
export interface ProjectStructure {
  project: Project;
  boards: Array<{
    board: Board;
    lists: List[];
  }>;
}

/**
 * Get all projects with their boards.
 */
export async function getProjects(): Promise<{
  projects: Project[];
  boards: Board[];
}> {
  const response = await plankaClient.get<unknown>("/api/projects");
  const parsed = ProjectsResponse.parse(response);
  const included = ProjectsIncludedSchema.parse(
    (response as Record<string, unknown>).included || {}
  );

  return {
    projects: parsed.items,
    boards: included.boards || [],
  };
}

/**
 * Get the full structure: projects -> boards -> lists.
 */
export async function getStructure(projectId?: string): Promise<ProjectStructure[]> {
  const { projects, boards } = await getProjects();

  // Filter to specific project if requested
  const targetProjects = projectId
    ? projects.filter((p) => p.id === projectId)
    : projects;

  const structures: ProjectStructure[] = [];

  for (const project of targetProjects) {
    const projectBoards = boards.filter((b) => b.projectId === project.id);
    const boardsWithLists: ProjectStructure["boards"] = [];

    for (const board of projectBoards) {
      // Get board details to get lists
      const boardResponse = await plankaClient.get<unknown>(
        `/api/boards/${board.id}`
      );
      const included = (boardResponse as Record<string, unknown>).included as
        | Record<string, unknown>
        | undefined;
      const lists = included?.lists
        ? z.array(z.object({
            id: z.string(),
            boardId: z.string(),
            name: z.string().nullable(),
            position: z.number().nullable(),
            createdAt: z.string(),
            updatedAt: z.string().nullable().optional(),
          })).parse(included.lists)
        : [];

      boardsWithLists.push({
        board,
        lists: lists.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
      });
    }

    structures.push({
      project,
      boards: boardsWithLists.sort(
        (a, b) => a.board.position - b.board.position
      ),
    });
  }

  return structures;
}
