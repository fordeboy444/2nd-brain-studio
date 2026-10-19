import * as fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every mutating filesystem function the preview path could reach is wrapped,
// so "preview writes nothing" is an assertion about calls, not about timing.
// The wrappers pass through, so the spec's own mkdtemp/rm still work.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    appendFile: vi.fn(actual.appendFile),
    mkdir: vi.fn(actual.mkdir),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    rm: vi.fn(actual.rm),
    open: vi.fn(actual.open),
  };
});
import type { VideoCandidate } from "../jobs/types.js";
import type { EnumerateResult } from "./enumerate.js";
import { previewJob, type PreviewDeps } from "./preview.js";
import { InvalidSourceUrlError } from "./urls.js";

function candidate(index: number): VideoCandidate {
  return {
    youtubeId: `v${String(index)}`,
    title: `Video ${String(index)}`,
    url: `https://youtu.be/v${String(index)}`,
    published: "2026-01-15",
    durationSec: 600,
    language: "en",
  };
}

function depsFor(
  candidates: VideoCandidate[],
  foundAtLeast = false,
): { deps: PreviewDeps; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    deps: {
      async enumerate(url: string): Promise<EnumerateResult> {
        urls.push(url);
        return { candidates, foundAtLeast };
      },
    },
  };
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "preview-spec-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("previewJob (INGEST-03)", () => {
  it("estimates 8 calls for one selected video", async () => {
    const { deps } = depsFor([candidate(1)]);
    const result = await previewJob(
      { channelUrl: "https://www.youtube.com/@demo", maxVideos: 5 },
      deps,
    );

    expect(result).toMatchObject({
      found: 1,
      selected: 1,
      skipped: [],
      estimatedCalls: 8,
      estimatedMinutes: 4,
    });
    expect(Number.isInteger(result.estimatedCalls)).toBe(true);
    expect(Number.isInteger(result.estimatedMinutes)).toBe(true);
  });

  it("estimates 12 calls for five selected videos", async () => {
    const { deps } = depsFor([1, 2, 3, 4, 5].map(candidate));
    const result = await previewJob(
      { channelUrl: "https://www.youtube.com/@demo", maxVideos: 10 },
      deps,
    );
    expect(result.estimatedCalls).toBe(12);
  });

  it("estimates 14 calls for six selected videos", async () => {
    const { deps } = depsFor([1, 2, 3, 4, 5, 6].map(candidate));
    const result = await previewJob(
      { channelUrl: "https://www.youtube.com/@demo", maxVideos: 10 },
      deps,
    );
    expect(result.estimatedCalls).toBe(14);
  });

  it("returns a complete estimate object for an empty selection", async () => {
    const { deps } = depsFor([]);
    const result = await previewJob(
      { channelUrl: "https://www.youtube.com/@demo", maxVideos: 10 },
      deps,
    );

    expect(result).toEqual({
      found: 0,
      selected: 0,
      skipped: [],
      estimatedCalls: 6,
      estimatedMinutes: 0,
    });
    expect(result.foundAtLeast).toBeUndefined();
  });

  it("takes selected from after filters and found from the enumeration", async () => {
    const { deps, urls } = depsFor([
      candidate(1),
      { ...candidate(2), published: "2020-01-01" },
      candidate(3),
    ]);
    const result = await previewJob(
      {
        channelUrl: "https://www.youtube.com/@demo",
        maxVideos: 10,
        dateFrom: "2026-01-01",
      },
      deps,
    );

    expect(result.found).toBe(3);
    expect(result.selected).toBe(2);
    expect(result.skipped).toEqual([
      expect.objectContaining({ youtubeId: "v2", reason: "outside_date_range" }),
    ]);
    // Enumeration receives the canonical /videos URL, never the raw input.
    expect(urls).toEqual(["https://www.youtube.com/@demo/videos"]);
  });

  it("carries foundAtLeast only when the scan cap was reached", async () => {
    const capped = await previewJob(
      { channelUrl: "https://www.youtube.com/@demo", maxVideos: 10 },
      depsFor([candidate(1)], true).deps,
    );
    expect(capped.foundAtLeast).toBe(true);

    const exact = await previewJob(
      { channelUrl: "https://www.youtube.com/@demo", maxVideos: 10 },
      depsFor([candidate(1)], false).deps,
    );
    expect(exact.foundAtLeast).toBeUndefined();
    expect(Object.keys(exact)).not.toContain("foundAtLeast");
  });

  it("rejects an invalid channel URL before calling the enumerator", async () => {
    const { deps, urls } = depsFor([candidate(1)]);
    await expect(
      previewJob({ channelUrl: "https://example.com/@x", maxVideos: 5 }, deps),
    ).rejects.toBeInstanceOf(InvalidSourceUrlError);
    expect(urls).toEqual([]);
  });

  it("writes nothing: no mutating filesystem function is called", async () => {
    // The spy must not count the spec's own setup or teardown.
    vi.clearAllMocks();

    const { deps } = depsFor([candidate(1), candidate(2)]);
    await previewJob(
      { channelUrl: "https://www.youtube.com/@demo", maxVideos: 5 },
      deps,
    );

    for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "open"] as const) {
      expect(vi.mocked(fs[name])).not.toHaveBeenCalled();
    }
  });
});
