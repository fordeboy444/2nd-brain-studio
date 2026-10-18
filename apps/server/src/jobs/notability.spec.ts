import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NotabilitySchema,
  notabilityPath,
  readNotability,
  writeNotability,
  type NotabilityRecord,
} from "./notability.js";

const AT = "2026-10-18T10:00:00.000Z";

function record(overrides: Partial<NotabilityRecord> = {}): NotabilityRecord {
  return {
    scores: [
      { slug: "the-piv-loop", score: 0.8 },
      { slug: "claude-code", score: 0.4 },
    ],
    at: AT,
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "notability-spec-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("notability artifact", () => {
  it("round-trips a record through the fsync-then-rename writer", async () => {
    await writeNotability(dir, record());
    const stored = await readNotability(dir);
    expect(stored).toEqual({
      scores: [
        { slug: "claude-code", score: 0.4 },
        { slug: "the-piv-loop", score: 0.8 },
      ],
      at: AT,
    });
    expect(notabilityPath(dir)).toBe(join(dir, "notability.json"));
  });

  it("writes scores in codepoint order", async () => {
    await writeNotability(dir, record());
    const raw = await readFile(notabilityPath(dir), "utf8");
    const parsed = JSON.parse(raw) as NotabilityRecord;
    expect(parsed.scores.map((score) => score.slug)).toEqual([
      "claude-code",
      "the-piv-loop",
    ]);
  });

  it("reads a missing file as null", async () => {
    expect(await readNotability(dir)).toBeNull();
  });

  it("reads a corrupt JSON file as null", async () => {
    await writeFile(notabilityPath(dir), "{ this is not json", "utf8");
    expect(await readNotability(dir)).toBeNull();
  });
});

describe("NotabilitySchema", () => {
  it("rejects a score outside 0..1", () => {
    expect(
      NotabilitySchema.safeParse({ scores: [{ slug: "x", score: 1.5 }], at: AT })
        .success,
    ).toBe(false);
    expect(
      NotabilitySchema.safeParse({ scores: [{ slug: "x", score: -0.1 }], at: AT })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(
      NotabilitySchema.safeParse({ scores: [], at: AT, extra: true }).success,
    ).toBe(false);
    expect(
      NotabilitySchema.safeParse({
        scores: [{ slug: "x", score: 0.5, note: "no" }],
        at: AT,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-kebab slug", () => {
    expect(
      NotabilitySchema.safeParse({
        scores: [{ slug: "Not A Slug", score: 0.5 }],
        at: AT,
      }).success,
    ).toBe(false);
  });
});
