import { describe, expect, it, vi } from "vitest";
import {
  CanonicalizeSchema,
  EDGE_KINDS,
  ENTITY_TYPES,
  ExtractionSchema,
  JsonRecoveryError,
  ManifestSchema,
  PageBodiesSchema,
  TaxonomyResponseSchema,
  TaxonomySchema,
  callJson,
  extractJson,
  parseWith,
  rawPathForAttempt,
  repairJson,
} from "./json.js";
import type { LlmChatOptions, LlmClient, LlmMessage } from "./ollama.js";

/**
 * One valid extraction body. Every adversarial fixture starts from this object
 * and injects exactly one defect, so a recovery assertion never depends on a
 * second defect hiding in the fixture.
 */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "the-piv-loop",
    title: "The PIV Loop",
    thesis: "Plan, implement, validate.",
    summary: "A short summary.",
    tags: ["Workflow", "workflow"],
    concepts: [{ name: "PIV Loop", slug: "The PIV Loop", weight: 0.8 }],
    entities: [{ name: "Claude Code", slug: "Claude Code", type: "Tool", weight: 1 }],
    quotes: [{ text: "a".repeat(300), startSec: "1:02:03" }],
    relations: [{ to: "Vibe Engineering", kind: "builds on" }],
    ...overrides,
  };
}

const compact = JSON.stringify(base());
const pretty = JSON.stringify(base(), null, 2);

const FIXTURES: ReadonlyArray<{ name: string; text: string }> = [
  { name: "a valid control", text: compact },
  { name: "fenced JSON", text: `\`\`\`json\n${compact}\n\`\`\`` },
  { name: "trailing prose", text: `${compact}\n\nThat is the JSON you asked for.` },
  { name: "a leading apology", text: `I am sorry, here is the JSON:\n${compact}` },
  {
    name: "smart quotes",
    text: compact.replace('"The PIV Loop"', "“The PIV Loop”"),
  },
  {
    name: "a trailing comma",
    text: `${pretty.slice(0, pretty.lastIndexOf("}"))},\n}`,
  },
  {
    name: "a truncated object",
    text: compact.slice(
      0,
      compact.indexOf('"relations":[') + '"relations":['.length,
    ),
  },
  {
    name: "an unescaped newline",
    text: compact.replace('"A short summary."', '"line one\nline two"'),
  },
  {
    name: "two objects",
    text: `${compact}\n${JSON.stringify(base({ slug: "second" }))}`,
  },
  {
    name: "single quotes",
    text: compact.replace('"slug":"the-piv-loop"', "'slug':'the-piv-loop'"),
  },
  {
    name: "a NaN literal",
    text: compact.replace('"weight":0.8', '"weight":NaN'),
  },
];

describe("callJson adversarial recovery (idea.md fixture list)", () => {
  it.each(FIXTURES)("recovers $name on attempt 1 without a repair call", ({ text }) => {
    const parsed = parseWith(text, ExtractionSchema);

    expect(parsed.slug).toBe("the-piv-loop");
    expect(parsed.title).toBe("The PIV Loop");
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.quotes[0]?.startSec).toBe(3_723);
  });

  it("drops trailing prose after the first balanced object", () => {
    expect(extractJson(`${compact}\nand then some prose`)).toBe(compact);
  });

  it("returns only the first of two balanced objects", () => {
    const second = JSON.stringify(base({ slug: "second" }));
    const extracted = JSON.parse(extractJson(`${compact}\n${second}`)) as {
      slug: string;
    };
    expect(extracted.slug).toBe("the-piv-loop");
  });

  it("strips comments outside strings while keeping // inside a string", () => {
    const repaired = repairJson(
      '{"slug": "a//b", // a comment\n "title": "T"}',
    );
    expect(JSON.parse(repaired)).toEqual({ slug: "a//b", title: "T" });
  });
});

describe("ExtractionSchema normalisation", () => {
  it("kebab-cases slugs, dedupes tags and forces the entity type enum", () => {
    const parsed = parseWith(compact, ExtractionSchema);

    expect(parsed.concepts[0]).toEqual({
      name: "PIV Loop",
      slug: "the-piv-loop",
      weight: 0.8,
    });
    expect(parsed.entities[0]).toEqual({
      name: "Claude Code",
      slug: "claude-code",
      type: "tool",
      weight: 1,
    });
    expect(parsed.tags).toEqual(["workflow"]);
    expect(EDGE_KINDS).toContain(parsed.relations[0]?.kind);
    expect(parsed.relations[0]).toEqual({ to: "vibe-engineering", kind: "builds_on" });
  });

  it("falls back to the name when a slug is empty or unusable", () => {
    const parsed = parseWith(
      JSON.stringify(
        base({
          concepts: [{ name: "The PIV Loop", slug: "", weight: 0.5 }],
          entities: [{ name: "Claude Code", slug: "!!!", type: "Tool", weight: 0.5 }],
        }),
      ),
      ExtractionSchema,
    );
    expect(parsed.concepts[0]?.slug).toBe("the-piv-loop");
    expect(parsed.entities[0]?.slug).toBe("claude-code");
  });

  it("maps an unknown entity type to `unknown`", () => {
    const parsed = parseWith(
      JSON.stringify(
        base({ entities: [{ name: "Thing", slug: "thing", type: "nonsense", weight: 1 }] }),
      ),
      ExtractionSchema,
    );
    expect(parsed.entities[0]?.type).toBe("unknown");
    expect(ENTITY_TYPES).toContain(parsed.entities[0]?.type);
  });

  it("clamps weights to 0..1 and turns a NaN into 0", () => {
    const parsed = parseWith(
      JSON.stringify(
        base({
          concepts: [
            { name: "High", slug: "high", weight: 9 },
            { name: "Low", slug: "low", weight: -2 },
            { name: "NaN", slug: "nan", weight: "NaN" },
          ],
        }),
      ),
      ExtractionSchema,
    );
    expect(parsed.concepts.map((concept) => concept.weight)).toEqual([1, 0, 0]);
  });

  it("caps quote text at 240 characters and keeps the whole text when shorter", () => {
    const parsed = parseWith(compact, ExtractionSchema);
    expect(parsed.quotes[0]?.text).toHaveLength(240);
  });

  it("drops only the quote whose timestamp does not parse", () => {
    const parsed = parseWith(
      JSON.stringify(
        base({
          quotes: [
            { text: "kept", startSec: "12:34" },
            { text: "dropped", startSec: "soon" },
            { text: "also kept", startSec: 42 },
          ],
        }),
      ),
      ExtractionSchema,
    );
    expect(parsed.quotes).toEqual([
      { text: "kept", startSec: 754 },
      { text: "also kept", startSec: 42 },
    ]);
  });

  it("parses H:MM:SS and MM:SS timestamps", () => {
    const parsed = parseWith(
      JSON.stringify(
        base({
          quotes: [
            { text: "a", startSec: "1:02:03" },
            { text: "b", startSec: "02:03" },
          ],
        }),
      ),
      ExtractionSchema,
    );
    expect(parsed.quotes.map((quote) => quote.startSec)).toEqual([3_723, 123]);
  });

  it("drops an unknown relation kind and an unusable target", () => {
    const parsed = parseWith(
      JSON.stringify(
        base({
          relations: [
            { to: "Vibe Engineering", kind: "builds on" },
            { to: "Vibe Engineering", kind: "invented" },
            { to: "!!!", kind: "part of" },
          ],
        }),
      ),
      ExtractionSchema,
    );
    expect(parsed.relations).toEqual([{ to: "vibe-engineering", kind: "builds_on" }]);
  });

  it("rejects an unknown top-level key", () => {
    expect(() =>
      ExtractionSchema.parse({ ...base(), surprise: true }),
    ).toThrow();
  });
});

describe("PageBodiesSchema", () => {
  it("accepts two to four prose paragraphs", () => {
    const parsed = PageBodiesSchema.parse([
      { slug: "the-piv-loop", body: "One paragraph.\n\nTwo paragraphs." },
    ]);
    expect(parsed[0]?.slug).toBe("the-piv-loop");
  });

  it("rejects a one-paragraph body and a five-paragraph body", () => {
    expect(() =>
      PageBodiesSchema.parse([{ slug: "x", body: "Only one paragraph." }]),
    ).toThrow();
    const five = ["1", "2", "3", "4", "5"].join("\n\n");
    expect(() => PageBodiesSchema.parse([{ slug: "x", body: five }])).toThrow();
  });

  it("rejects a body containing a markdown heading", () => {
    expect(() =>
      PageBodiesSchema.parse([
        { slug: "x", body: "First paragraph.\n\n## Heading\n\nSecond paragraph." },
      ]),
    ).toThrow();
  });

  it("rejects a body containing a markdown link or wikilink", () => {
    expect(() =>
      PageBodiesSchema.parse([
        { slug: "x", body: "First paragraph.\n\nSee [x](y) for more." },
      ]),
    ).toThrow();
    expect(() =>
      PageBodiesSchema.parse([
        { slug: "x", body: "First paragraph.\n\nSee [[other]] for more." },
      ]),
    ).toThrow();
  });
});

describe("S3 schemas", () => {
  it("validates the canonicalisation envelope and slugifies from/to", () => {
    const parsed = CanonicalizeSchema.parse({
      labels: [
        {
          from: "The PIV Loop",
          to: "PIV Loop",
          title: "PIV Loop",
          tags: ["Workflow"],
          aliases: ["Plan Implement Validate"],
        },
      ],
    });

    expect(parsed.labels[0]).toEqual({
      from: "the-piv-loop",
      to: "piv-loop",
      title: "PIV Loop",
      tags: ["workflow"],
      aliases: ["Plan Implement Validate"],
    });
  });

  it("rejects a canonicalisation label with an empty title or unknown top-level key", () => {
    expect(() =>
      CanonicalizeSchema.parse({
        labels: [{ from: "a", to: "b", title: "", tags: [], aliases: [] }],
      }),
    ).toThrow();
    expect(() =>
      CanonicalizeSchema.parse({ labels: [], extra: true }),
    ).toThrow();
  });

  it("validates the taxonomy reply and the stored taxonomy document", () => {
    const reply = {
      concept_themes: [{ name: "Workflow", slug: "workflow", members: ["the-piv-loop"] }],
      tool_themes: [{ name: "Coding", slug: "coding", members: ["claude-code"] }],
      source_clusters: [],
    };

    expect(TaxonomyResponseSchema.parse(reply)).toEqual(reply);
    expect(TaxonomySchema.parse({ ...reply, at: "2026-10-18T00:00:00.000Z" })).toEqual({
      ...reply,
      at: "2026-10-18T00:00:00.000Z",
    });
    expect(() => TaxonomyResponseSchema.parse({ ...reply, extra: true })).toThrow();
  });

  it("validates a stored manifest and rejects an unknown key", () => {
    const manifest = {
      concepts: [
        {
          slug: "the-piv-loop",
          title: "PIV Loop",
          tags: ["workflow"],
          sources: ["video-one"],
          weight: 0.8,
        },
      ],
      entities: [
        {
          slug: "claude-code",
          title: "Claude Code",
          type: "tool",
          tags: ["coding"],
          sources: ["video-one"],
          weight: 1,
        },
      ],
      sources: [
        {
          slug: "video-one",
          title: "One",
          kind: "video",
          tags: ["workflow"],
          concepts: ["the-piv-loop"],
          entities: ["claude-code"],
          youtube_id: "abcdefghijk",
          duration: 600,
        },
        {
          slug: "page-one",
          title: "Page",
          kind: "web",
          tags: [],
          concepts: [],
          entities: [],
          url: "https://example.test/page",
        },
      ],
      edges: [{ from: "the-piv-loop", to: "claude-code", kind: "related_to" }],
      filtered: [{ slug: "too-thin", kind: "concept", reason: "single_source" }],
      at: "2026-10-18T00:00:00.000Z",
    };

    expect(ManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() => ManifestSchema.parse({ ...manifest, notability: [] })).toThrow();
  });

  it("requires youtube_id for a video source and url for a web source", () => {
    const source = {
      slug: "one",
      title: "One",
      kind: "video",
      tags: [],
      concepts: [],
      entities: [],
    };
    const document = {
      concepts: [],
      entities: [],
      sources: [source],
      edges: [],
      filtered: [],
      at: "2026-10-18T00:00:00.000Z",
    };
    expect(() => ManifestSchema.parse(document)).toThrow();

    expect(() =>
      ManifestSchema.parse({
        ...document,
        sources: [{ ...source, kind: "web" }],
      }),
    ).toThrow();
  });
});

describe("rawPathForAttempt", () => {
  it("names the stage-unit-attempt file under llm/", () => {
    expect(rawPathForAttempt("/tmp/job", "S2", "the-piv-loop", 2)).toBe(
      "/tmp/job/llm/S2-the-piv-loop-2.txt",
    );
  });
});

interface FakeCall {
  messages: readonly LlmMessage[];
  options: LlmChatOptions;
}

function fakeClient(replies: readonly string[]): {
  client: LlmClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let index = 0;
  const client: LlmClient = {
    async chat(messages, options) {
      calls.push({ messages, options });
      const text = replies[Math.min(index, replies.length - 1)] ?? "";
      index += 1;
      return { text, tokensIn: 1, tokensOut: 2 };
    },
  };
  return { client, calls };
}

const MESSAGES: readonly LlmMessage[] = [
  { role: "system", content: "Extract JSON." },
  { role: "user", content: "The transcript." },
];

const CALL_OPTIONS = {
  model: "test-model",
  baseUrl: "https://ollama.com",
  timeoutMs: 1_000,
  maxRetries: 0,
};

describe("callJson attempt ladder", () => {
  it("returns the attempt-1 value with one call", async () => {
    const { client, calls } = fakeClient([compact]);

    const parsed = await callJson(client, MESSAGES, ExtractionSchema, CALL_OPTIONS);

    expect(parsed.slug).toBe("the-piv-loop");
    expect(calls).toHaveLength(1);
  });

  it("repairs on attempt 2 with the validator error list", async () => {
    const { client, calls } = fakeClient(["this is not JSON at all", compact]);

    const parsed = await callJson(client, MESSAGES, ExtractionSchema, CALL_OPTIONS);

    expect(parsed.slug).toBe("the-piv-loop");
    expect(calls).toHaveLength(2);
    const repair = calls[1]?.messages.at(-1);
    expect(repair?.role).toBe("user");
    expect(repair?.content).toContain("Your previous output was not valid:");
    expect(repair?.content).toContain("Return ONLY the corrected JSON.");
  });

  it("makes exactly three calls and throws JsonRecoveryError with the errors", async () => {
    const { client, calls } = fakeClient(["definitely not json"]);

    let thrown: unknown;
    try {
      await callJson(client, MESSAGES, ExtractionSchema, CALL_OPTIONS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(JsonRecoveryError);
    expect(calls).toHaveLength(3);
    expect((thrown as JsonRecoveryError).attempts).toBe(3);
    expect((thrown as JsonRecoveryError).errors).toHaveLength(3);
    expect((thrown as JsonRecoveryError).errors[0]).toBeTruthy();
  });

  it("never makes a fourth call", async () => {
    const { client, calls } = fakeClient(["not json"]);
    await expect(
      callJson(client, MESSAGES, ExtractionSchema, CALL_OPTIONS),
    ).rejects.toBeInstanceOf(JsonRecoveryError);
    expect(calls).toHaveLength(3);
  });

  it("echoes the previous bad output truncated to 4000 characters on attempt 3", async () => {
    const longBad = `${"y".repeat(6_000)} not json`;
    const { client, calls } = fakeClient([longBad, longBad]);

    await expect(
      callJson(client, MESSAGES, ExtractionSchema, CALL_OPTIONS),
    ).rejects.toBeInstanceOf(JsonRecoveryError);

    const third = calls[2]?.messages.at(-1)?.content ?? "";
    expect(third).toContain("y".repeat(4_000));
    expect(third).not.toContain("y".repeat(4_001));
  });

  it("asks the client to write every attempt's raw reply through the namer", async () => {
    const { client, calls } = fakeClient(["not json", "still not json", compact]);
    const namer = vi.fn((attempt: number) => `/job/llm/S2-unit-${attempt}.txt`);

    await callJson(client, MESSAGES, ExtractionSchema, {
      ...CALL_OPTIONS,
      rawPathForAttempt: namer,
    });

    expect(namer.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.options.rawPath)).toEqual([
      "/job/llm/S2-unit-1.txt",
      "/job/llm/S2-unit-2.txt",
      "/job/llm/S2-unit-3.txt",
    ]);
  });
});
