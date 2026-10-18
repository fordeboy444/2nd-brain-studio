import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readManifest,
  readTaxonomy,
  sortManifest,
  writeManifest,
  writeTaxonomy,
  type ManifestRecord,
  type TaxonomyRecord,
} from "./manifest.js";

const AT = "2026-10-18T10:00:00.000Z";

function manifest(overrides: Partial<ManifestRecord> = {}): ManifestRecord {
  return {
    concepts: [
      {
        slug: "the-piv-loop",
        title: "The PIV Loop",
        tags: ["agents", "workflow"],
        sources: ["second-talk", "first-talk"],
        weight: 0.9,
      },
    ],
    entities: [
      {
        slug: "claude-code",
        title: "Claude Code",
        type: "tool",
        tags: ["tooling"],
        sources: ["first-talk"],
        weight: 0.7,
      },
    ],
    sources: [
      {
        slug: "first-talk",
        title: "First Talk",
        kind: "video",
        tags: ["agents"],
        concepts: ["the-piv-loop"],
        entities: ["claude-code"],
        youtube_id: "abc123",
        duration: 1200,
      },
      {
        slug: "example-post",
        title: "Example Post",
        kind: "web",
        tags: ["agents"],
        concepts: [],
        entities: [],
        url: "https://example.com/post",
      },
    ],
    edges: [
      {
        from: "the-piv-loop",
        to: "claude-code",
        kind: "related_to",
      },
    ],
    filtered: [{ slug: "one-off-tool", kind: "entity", reason: "single_source" }],
    at: AT,
    ...overrides,
  };
}

function taxonomy(overrides: Partial<TaxonomyRecord> = {}): TaxonomyRecord {
  return {
    concept_themes: [
      { name: "Agent loops", slug: "agent-loops", members: ["the-piv-loop"] },
    ],
    tool_themes: [
      { name: "Tooling", slug: "tooling", members: ["claude-code"] },
    ],
    source_clusters: [
      { name: "Talks", slug: "talks", members: ["first-talk"] },
    ],
    at: AT,
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "manifest-spec-"));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("manifest artifact", () => {
  it("round-trips through the strict schema with sorted arrays", async () => {
    await writeManifest(dir, manifest());

    const stored = await readManifest(dir);
    // Writing a deliberately unsorted record still yields the total order.
    const unsorted = manifest({
      sources: [...manifest().sources].reverse(),
      concepts: manifest().concepts.map((concept) => ({
        ...concept,
        sources: [...concept.sources].reverse(),
        tags: [...concept.tags].reverse(),
      })),
    });
    expect(stored).toEqual(sortManifest(unsorted));
    expect(stored?.concepts[0]?.sources).toEqual(["first-talk", "second-talk"]);
    expect(stored?.sources.map((source) => source.slug)).toEqual([
      "example-post",
      "first-talk",
    ]);
    expect(stored?.at).toBe(AT);
  });

  it("writes byte-identical JSON for the same record twice", async () => {
    await writeManifest(dir, manifest());
    const first = await readFile(join(dir, "manifest.json"), "utf8");
    await writeManifest(dir, manifest());
    const second = await readFile(join(dir, "manifest.json"), "utf8");
    expect(second).toBe(first);
  });

  it("returns null for a missing file and for a corrupt document", async () => {
    expect(await readManifest(dir)).toBeNull();

    await writeFile(join(dir, "manifest.json"), "{ not json", "utf8");
    expect(await readManifest(dir)).toBeNull();

    // A schema violation is corrupt, not a usable manifest.
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ ...manifest(), unexpected: true }),
      "utf8",
    );
    expect(await readManifest(dir)).toBeNull();
  });

  it("preserves the source identity keys a fallback page needs", async () => {
    await writeManifest(dir, manifest());
    const stored = await readManifest(dir);
    const video = stored?.sources.find((source) => source.slug === "first-talk");
    const web = stored?.sources.find((source) => source.slug === "example-post");
    expect(video?.youtube_id).toBe("abc123");
    expect(video?.duration).toBe(1200);
    expect(web?.url).toBe("https://example.com/post");
  });
});

describe("taxonomy artifact", () => {
  it("round-trips and sorts themes by slug", async () => {
    await writeTaxonomy(dir, taxonomy());
    const stored = await readTaxonomy(dir);
    expect(stored?.concept_themes[0]?.slug).toBe("agent-loops");
    expect(stored?.at).toBe(AT);

    expect(await readTaxonomy(join(dir, "missing"))).toBeNull();
    await writeFile(join(dir, "taxonomy.json"), "garbage", "utf8");
    expect(await readTaxonomy(dir)).toBeNull();
  });

  it("writes stable bytes across two writes", async () => {
    await writeTaxonomy(dir, taxonomy());
    const first = await readFile(join(dir, "taxonomy.json"), "utf8");
    await writeTaxonomy(dir, taxonomy());
    expect(await readFile(join(dir, "taxonomy.json"), "utf8")).toBe(first);
  });
});
