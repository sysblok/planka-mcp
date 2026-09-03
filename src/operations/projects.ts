/**
 * Project operations for PLANKA API.
 */
import { plankaClient } from "../client.js";
import { parseInput, PlankaError } from "../errors.js";
import {
  assertProjectAllowed,
  getPolicy,
  isBoardAllowed,
  isProjectAllowed,
} from "../config/policy.js";
import { Project, Board, List } from "../schemas/entities.js";
import { ProjectsResponse, ProjectsIncludedSchema } from "../schemas/responses.js";
import { GetStructureSchema, GetStructureInput } from "../schemas/requests.js";
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

  return applyAllowlists(parsed.items, included.boards || []);
}

/**
 * Trims what Planka answered down to what this server is allowed to show.
 *
 * Filtering here (and not only at call time) is the point: an agent that
 * cannot SEE the other boards never tries to touch them, and the error paths
 * that list "known boards" stop leaking names from projects out of scope.
 */
export function applyAllowlists(
  projects: Project[],
  boards: Board[]
): { projects: Project[]; boards: Board[] } {
  const policy = getPolicy();
  if (policy.allowedProjectIds === null && policy.allowedBoardIds === null) {
    return { projects, boards };
  }

  let visibleProjects = projects.filter((p) => isProjectAllowed(p.id, policy));
  const projectIds = new Set(visibleProjects.map((p) => p.id));

  const visibleBoards = boards.filter(
    (b) => projectIds.has(b.projectId) && isBoardAllowed(b.id, policy)
  );

  // With a board allowlist, a project with no allowed board is noise.
  if (policy.allowedBoardIds !== null) {
    const withBoards = new Set(visibleBoards.map((b) => b.projectId));
    visibleProjects = visibleProjects.filter((p) => withBoards.has(p.id));
  }

  return { projects: visibleProjects, boards: visibleBoards };
}

/**
 * Get the full structure: projects -> boards -> lists.
 *
 * `GET /api/projects` already carries every visible board, so with
 * `withLists: false` the whole structure is ONE request. With lists (the
 * default, kept so existing callers keep their column IDs) it costs one board
 * read per board — the N+1 that `planka_board_summary` avoids.
 */
export async function getStructure(
  input: GetStructureInput = {}
): Promise<ProjectStructure[]> {
  const { projectId, withLists } = parseInput(GetStructureSchema, input);

  // Outside the allowlist: say so instead of answering an empty structure.
  if (projectId) assertProjectAllowed(projectId);

  const { projects, boards } = await getProjects();

  // Filter to specific project if requested
  let targetProjects = projects;
  if (projectId) {
    targetProjects = projects.filter((p) => p.id === projectId);
    if (targetProjects.length === 0) {
      const known = projects
        .map((p) => `  - ${p.id} — "${p.name}"`)
        .join("\n");
      throw new PlankaError(
        `No project with id ${projectId} is visible to this account. ` +
          (projects.length
            ? `Visible projects:\n${known}`
            : "No projects are visible at all — check the credentials and the board memberships of the Planka user."),
        "NOT_FOUND",
        404
      );
    }
  }

  const structures: ProjectStructure[] = [];

  for (const project of targetProjects) {
    const projectBoards = boards.filter((b) => b.projectId === project.id);
    const boardsWithLists: ProjectStructure["boards"] = [];

    for (const board of projectBoards) {
      // Planka has no per-board list endpoint: the columns only come inside a
      // full board read (every card, every attachment). One per board — so it
      // only happens when the caller asked for the lists.
      if (!withLists) {
        boardsWithLists.push({ board, lists: [] });
        continue;
      }

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
