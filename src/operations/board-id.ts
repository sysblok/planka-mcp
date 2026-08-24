/**
 * Board id resolution: turn a bare 404 into something a model can act on.
 *
 * Why it exists: in Planka, project ids and board ids are both strings of
 * digits, indistinguishable at a glance. Handing a projectId to a tool that
 * expects a boardId gets `GET /api/boards/<projectId>` → a naked 404, and an
 * agent burns a whole cycle discovering it picked the wrong entity.
 *
 * With this, that 404 becomes either:
 *   - an automatic resolution, when the project has exactly one board; or
 *   - an error saying "that is a projectId, and these are its boards".
 */
import { PlankaError, PlankaNotFoundError } from "../errors.js";
import { getProjects } from "./projects.js";

/** A 404 can arrive as PlankaNotFoundError or as PlankaError with status 404. */
function isNotFound(error: unknown): boolean {
  if (error instanceof PlankaNotFoundError) return true;
  return error instanceof PlankaError && error.status === 404;
}

/** Formats `id — name` for the listings inside error messages. */
function describe(id: string, name: string | null | undefined): string {
  return name ? `${id} — "${name}"` : id;
}

/**
 * Diagnoses an id that failed as a board: was it actually a projectId?
 *
 * Returns the boardId to retry when the resolution is unambiguous (a project
 * with exactly one board). In every other case it throws an actionable error
 * and never returns.
 */
async function diagnoseBoardId(boardId: string): Promise<string> {
  let projects;
  let boards;

  try {
    ({ projects, boards } = await getProjects());
  } catch {
    // If we cannot even list projects, the original 404 is the best
    // information available: let the caller re-throw it.
    throw new PlankaNotFoundError("Board", boardId);
  }

  const asProject = projects.find((p) => p.id === boardId);

  if (asProject) {
    const projectBoards = boards.filter((b) => b.projectId === asProject.id);

    if (projectBoards.length === 1) {
      return projectBoards[0].id;
    }

    if (projectBoards.length === 0) {
      throw new PlankaError(
        `${boardId} is a projectId (project "${asProject.name}"), not a boardId — ` +
          `and that project has no boards yet. Create one, or call planka_get_structure to see what exists.`,
        "WRONG_ENTITY_TYPE",
        404
      );
    }

    const list = projectBoards
      .map((b) => `  - ${describe(b.id, b.name)}`)
      .join("\n");

    throw new PlankaError(
      `${boardId} is a projectId (project "${asProject.name}"), not a boardId. ` +
        `That project has ${projectBoards.length} boards — pass one of these instead:\n${list}`,
      "WRONG_ENTITY_TYPE",
      404
    );
  }

  // Neither project nor board: show the boards that do exist, which is what
  // the caller needs to correct itself on the next attempt.
  const known = boards.map((b) => `  - ${describe(b.id, b.name)}`).join("\n");

  throw new PlankaError(
    `No board with id ${boardId}, and it is not a projectId either. ` +
      (boards.length
        ? `Known boards:\n${known}\nUse planka_get_structure for the full project/board tree.`
        : `No boards are visible to this account. Check credentials or call planka_get_structure.`),
    "NOT_FOUND",
    404
  );
}

/**
 * Runs an operation that needs a boardId and, on a 404, tries to explain why
 * instead of propagating the mute 404.
 *
 * `run` receives the id to use: it is invoked again with the resolved board
 * when the id turned out to be a single-board project.
 */
export async function withBoardId<T>(
  boardId: string,
  run: (id: string) => Promise<T>
): Promise<T> {
  try {
    return await run(boardId);
  } catch (error) {
    if (!isNotFound(error)) throw error;

    // diagnoseBoardId throws unless the resolution is unambiguous.
    const resolved = await diagnoseBoardId(boardId);
    return await run(resolved);
  }
}
