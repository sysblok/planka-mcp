import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlankaNotFoundError } from "../../src/errors.js";

const mocks = vi.hoisted(() => ({ getProjects: vi.fn() }));

vi.mock("../../src/operations/projects.js", () => ({
  getProjects: mocks.getProjects,
}));

import { withBoardId } from "../../src/operations/board-id.js";

const projects = [{ id: "project-1", name: "Agent Work" }];

describe("withBoardId", () => {
  beforeEach(() => mocks.getProjects.mockReset());

  it("does not touch the happy path", async () => {
    const run = vi.fn(async (id: string) => `board:${id}`);
    await expect(withBoardId("board-1", run)).resolves.toBe("board:board-1");
    expect(mocks.getProjects).not.toHaveBeenCalled();
  });

  it("resolves a projectId on its own when the project has one board", async () => {
    mocks.getProjects.mockResolvedValue({
      projects,
      boards: [{ id: "board-1", projectId: "project-1", name: "Main" }],
    });

    const run = vi.fn(async (id: string) => {
      if (id === "project-1") throw new PlankaNotFoundError("Board", id);
      return `board:${id}`;
    });

    await expect(withBoardId("project-1", run)).resolves.toBe("board:board-1");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("says it is a projectId and lists the boards when there are several", async () => {
    mocks.getProjects.mockResolvedValue({
      projects,
      boards: [
        { id: "board-1", projectId: "project-1", name: "Main" },
        { id: "board-2", projectId: "project-1", name: "Backlog" },
      ],
    });

    await expect(
      withBoardId("project-1", async (id) => {
        throw new PlankaNotFoundError("Board", id);
      })
    ).rejects.toThrow(/is a projectId.*Backlog/s);
  });

  it("lists the real boards when the id is neither project nor board", async () => {
    mocks.getProjects.mockResolvedValue({
      projects,
      boards: [{ id: "board-1", projectId: "project-1", name: "Main" }],
    });

    await expect(
      withBoardId("999", async (id) => {
        throw new PlankaNotFoundError("Board", id);
      })
    ).rejects.toThrow(/not a projectId either[\s\S]*board-1/);
  });

  it("leaves errors that are not 404s alone", async () => {
    await expect(
      withBoardId("board-1", async () => {
        throw new Error("connection reset");
      })
    ).rejects.toThrow("connection reset");
    expect(mocks.getProjects).not.toHaveBeenCalled();
  });
});
