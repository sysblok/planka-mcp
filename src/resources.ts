/**
 * MCP resources: the guides that travel in the tarball, served over the wire.
 *
 * Why resources and not more `instructions`: a resource costs nothing until
 * someone reads it. `instructions` is a fixed per-session cost paid on top of
 * `tools/list`, so it holds only what every session needs; everything longer —
 * the workflow guide, the board template, the two skills, the Planka 2.x
 * gotchas — lives here and is pulled on demand (Claude Code by `@`-mention,
 * Cursor from its resource picker). Codex does not support resources; that is
 * why nothing here is load-bearing for correctness.
 *
 * Files are read from the published package at runtime, resolved from
 * `import.meta.url`, so `dist/resources.js` and `src/resources.ts` both sit one
 * level under the package root and find `workflow/` and `docs/` the same way.
 * A missing file is not an error: an install that trimmed the tarball gets a
 * short note pointing at the repository instead of a broken read.
 */
import { readFile } from "node:fs/promises";
import { LabelColorSchema } from "./schemas/entities.js";

const REPO_URL = "https://github.com/omnicoreos/planka-mcp";

export interface ResourceDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** Path inside the package, relative to its root. Absent = generated. */
  file?: string;
  /** Generated resources build their own body. */
  generate?: () => string;
}

/** The valid Planka label colors, straight from the schema the tools validate with. */
export function labelColorsDocument(): string {
  return JSON.stringify(
    {
      description:
        "Valid values for the `color` field of planka_create_label and planka_update_label. Planka rejects anything else with a validation error.",
      colors: LabelColorSchema.options,
      count: LabelColorSchema.options.length,
    },
    null,
    2
  );
}

/**
 * The catalogue. Order is fixed on purpose: `resources/list` should be
 * deterministic so clients can cache it and prompt caches keep hitting.
 */
export const RESOURCES: readonly ResourceDefinition[] = [
  {
    uri: "planka://workflow/readme",
    name: "workflow-readme",
    title: "Planka agent workflow",
    description:
      "The optional board workflow: columns, labels, who moves what, and the director/worker split. Read it before running cards in parallel.",
    mimeType: "text/markdown",
    file: "workflow/README.md",
  },
  {
    uri: "planka://workflow/board-template",
    name: "workflow-board-template",
    title: "Workflow board template",
    description:
      "The columns and labels the workflow expects, ready to create on a fresh board.",
    mimeType: "text/markdown",
    file: "workflow/board-template.md",
  },
  {
    uri: "planka://workflow/skills/orchestrator",
    name: "skill-orchestrator",
    title: "Skill: planka-orchestrator",
    description:
      "Director role: select cards, dispatch one worker per card, audit evidence, merge. Same text the plugin installs as a skill.",
    mimeType: "text/markdown",
    file: "workflow/skills/planka-orchestrator/SKILL.md",
  },
  {
    uri: "planka://workflow/skills/close-card",
    name: "skill-close-card",
    title: "Skill: planka-close-card",
    description:
      "Closing a card honestly: required evidence, the closing comment template, and which transition each role owns.",
    mimeType: "text/markdown",
    file: "workflow/skills/planka-close-card/SKILL.md",
  },
  {
    uri: "planka://gotchas/planka-2x",
    name: "planka-2x-gotchas",
    title: "Planka 2.x gotchas",
    description:
      "How Planka 2.x actually behaves: HTML-with-200 on unknown GETs, 404 that means 403, fixed page sizes, archive lists. Read this when a call answers something that makes no sense.",
    mimeType: "text/markdown",
    file: "docs/planka-2x-gotchas.md",
  },
  {
    uri: "planka://labels/colors",
    name: "label-colors",
    title: "Valid label colors",
    description:
      "Every color planka_create_label and planka_update_label accept, as JSON. Generated from the schema, so it can never drift from what the server validates.",
    mimeType: "application/json",
    generate: labelColorsDocument,
  },
];

const byUri = new Map(RESOURCES.map((resource) => [resource.uri, resource]));

/** Package root: this module lives one level under it in both src/ and dist/. */
function packageRoot(): URL {
  return new URL("../", import.meta.url);
}

function missingFileNote(resource: ResourceDefinition): string {
  return (
    `${resource.title} is not present in this installation ` +
    `(expected ${resource.file}). Read it at ${REPO_URL}/blob/main/${resource.file}.`
  );
}

/** Everything `resources/list` answers. Shape matches the MCP `Resource` type. */
export function listResources() {
  return RESOURCES.map(({ uri, name, title, description, mimeType }) => ({
    uri,
    name,
    title,
    description,
    mimeType,
  }));
}

/**
 * Body of one resource. Unknown URIs throw: a resource read that silently
 * answers empty is the same false green as a write that never re-reads.
 */
export async function readResource(uri: string): Promise<{
  contents: { uri: string; mimeType: string; text: string }[];
}> {
  const resource = byUri.get(uri);
  if (!resource) {
    throw new Error(
      `Unknown resource: ${uri}. Available: ${RESOURCES.map((r) => r.uri).join(", ")}`
    );
  }

  let text: string;
  if (resource.generate) {
    text = resource.generate();
  } else {
    try {
      text = await readFile(new URL(resource.file!, packageRoot()), "utf8");
    } catch {
      text = missingFileNote(resource);
    }
  }

  return {
    contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }],
  };
}
