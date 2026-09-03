import { describe, expect, it } from "vitest";
import {
  RESOURCES,
  listResources,
  readResource,
  labelColorsDocument,
} from "../../src/resources.js";
import { LabelColorSchema } from "../../src/schemas/entities.js";

describe("resources/list", () => {
  it("lists every resource with a URI, a name and a mime type", () => {
    const listed = listResources();
    expect(listed).toHaveLength(RESOURCES.length);
    for (const resource of listed) {
      expect(resource.uri).toMatch(/^planka:\/\//);
      expect(resource.name).toBeTruthy();
      expect(resource.title).toBeTruthy();
      expect(resource.description).toBeTruthy();
      expect(resource.mimeType).toMatch(/^(text\/markdown|application\/json)$/);
    }
  });

  it("has no duplicate URIs and keeps a deterministic order", () => {
    const uris = listResources().map((resource) => resource.uri);
    expect(new Set(uris).size).toBe(uris.length);
    expect(listResources().map((r) => r.uri)).toEqual(uris);
  });
});

describe("resources/read", () => {
  it.each(RESOURCES.map((resource) => resource.uri))(
    "reads %s with real content and the declared mime type",
    async (uri) => {
      const definition = RESOURCES.find((resource) => resource.uri === uri)!;
      const { contents } = await readResource(uri);
      expect(contents).toHaveLength(1);
      expect(contents[0].uri).toBe(uri);
      expect(contents[0].mimeType).toBe(definition.mimeType);
      // A file resource that fell back to the "not in this installation" note
      // is a packaging bug, so assert the real body, not just a non-empty one.
      expect(contents[0].text.length).toBeGreaterThan(500);
      expect(contents[0].text).not.toContain("is not present in this installation");
    }
  );

  it("names the alternatives instead of answering empty for an unknown URI", async () => {
    await expect(readResource("planka://nope")).rejects.toThrow(
      /Unknown resource: planka:\/\/nope\. Available: planka:\/\/workflow\/readme/
    );
  });

  it("serves the label colors straight from the schema the tools validate with", async () => {
    const parsed = JSON.parse(labelColorsDocument());
    expect(parsed.colors).toEqual(LabelColorSchema.options);
    expect(parsed.count).toBe(LabelColorSchema.options.length);
    const { contents } = await readResource("planka://labels/colors");
    expect(JSON.parse(contents[0].text).colors).toEqual(LabelColorSchema.options);
  });

  it("serves the two workflow skills the plugin installs", async () => {
    const orchestrator = await readResource("planka://workflow/skills/orchestrator");
    expect(orchestrator.contents[0].text).toContain("name: planka-orchestrator");
    const close = await readResource("planka://workflow/skills/close-card");
    expect(close.contents[0].text).toContain("name: planka-close-card");
  });
});
