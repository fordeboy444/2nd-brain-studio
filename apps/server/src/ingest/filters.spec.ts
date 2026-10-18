import { describe, expect, it } from "vitest";
import type { VideoCandidate } from "../jobs/types.js";
import { applyFilters, estimateCalls, estimateMinutes } from "./filters.js";

function candidate(overrides: Partial<VideoCandidate> = {}): VideoCandidate {
  return {
    youtubeId: "v1",
    title: "Video One",
    url: "https://youtu.be/v1",
    published: "2026-01-15",
    durationSec: 600,
    language: "en",
    ...overrides,
  };
}

describe("applyFilters (INGEST-02)", () => {
  it("includes both date boundaries and rejects the days outside them", () => {
    const input = candidate({ youtubeId: "in-start", published: "2026-01-10" });
    const output = candidate({ youtubeId: "in-end", published: "2026-01-20" });
    const before = candidate({ youtubeId: "before", published: "2026-01-09" });
    const after = candidate({ youtubeId: "after", published: "2026-01-21" });

    const result = applyFilters([input, before, output, after], {
      maxVideos: 10,
      dateFrom: "2026-01-10",
      dateTo: "2026-01-20",
    });

    expect(result.selected.map((c) => c.youtubeId)).toEqual(["in-start", "in-end"]);
    expect(result.skipped.map((s) => [s.youtubeId, s.reason])).toEqual([
      ["before", "outside_date_range"],
      ["after", "outside_date_range"],
    ]);
  });

  it("includes a duration equal to the minimum, rejects below it and keeps above it", () => {
    const equal = candidate({ youtubeId: "equal", durationSec: 300 });
    const above = candidate({ youtubeId: "above", durationSec: 301 });
    const below = candidate({ youtubeId: "below", durationSec: 299 });

    const result = applyFilters([equal, above, below], {
      maxVideos: 10,
      minDurationSec: 300,
    });

    expect(result.selected.map((c) => c.youtubeId)).toEqual(["equal", "above"]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ youtubeId: "below", reason: "below_min_duration" }),
    ]);
  });

  it("matches language case-insensitively", () => {
    const upper = candidate({ youtubeId: "upper", language: "EN" });
    const lower = candidate({ youtubeId: "lower", language: "en" });
    const other = candidate({ youtubeId: "other", language: "de" });

    const result = applyFilters([upper, lower, other], { maxVideos: 10, language: "En" });

    expect(result.selected.map((c) => c.youtubeId)).toEqual(["upper", "lower"]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ youtubeId: "other", reason: "wrong_language" }),
    ]);
  });

  it("reports unknown_metadata only when the matching filter is set", () => {
    const bare = candidate({
      youtubeId: "bare",
      published: undefined,
      durationSec: undefined,
      language: undefined,
    });

    const withFilters = applyFilters([bare], {
      maxVideos: 10,
      dateFrom: "2026-01-01",
      minDurationSec: 60,
      language: "en",
    });
    expect(withFilters.selected).toHaveLength(0);
    expect(withFilters.skipped[0]).toMatchObject({
      youtubeId: "bare",
      reason: "unknown_metadata",
    });

    const withoutFilters = applyFilters([bare], { maxVideos: 10 });
    expect(withoutFilters.selected.map((c) => c.youtubeId)).toEqual(["bare"]);
    expect(withoutFilters.skipped).toEqual([]);
  });

  it("applies the fixed order: date before duration before language", () => {
    // Fails date AND duration: the date filter runs first.
    const dateFirst = candidate({
      youtubeId: "date-first",
      published: "2020-01-01",
      durationSec: 1,
      language: "de",
    });
    // Passes date, fails duration AND language: duration runs next.
    const durationNext = candidate({
      youtubeId: "duration-next",
      published: "2026-01-15",
      durationSec: 1,
      language: "de",
    });
    // Passes date and duration, fails language.
    const languageLast = candidate({
      youtubeId: "language-last",
      published: "2026-01-15",
      durationSec: 600,
      language: "de",
    });

    const result = applyFilters([dateFirst, durationNext, languageLast], {
      maxVideos: 10,
      dateFrom: "2026-01-01",
      minDurationSec: 60,
      language: "en",
    });

    expect(result.skipped.map((s) => [s.youtubeId, s.reason])).toEqual([
      ["date-first", "outside_date_range"],
      ["duration-next", "below_min_duration"],
      ["language-last", "wrong_language"],
    ]);
  });

  it("keeps only the first maxVideos survivors and does not record truncation", () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      candidate({ youtubeId: `v${i}`, title: `Video ${i}` }),
    );

    const one = applyFilters(many, { maxVideos: 1 });
    expect(one.selected.map((c) => c.youtubeId)).toEqual(["v0"]);
    expect(one.skipped).toEqual([]);

    const two = applyFilters(many, { maxVideos: 2 });
    expect(two.selected.map((c) => c.youtubeId)).toEqual(["v0", "v1"]);
    expect(two.skipped).toEqual([]);
  });

  it("preserves source order and returns a complete empty result", () => {
    const first = candidate({ youtubeId: "z-last-in-source", title: "Alpha" });
    const second = candidate({ youtubeId: "a-first-in-source", title: "Beta" });

    const kept = applyFilters([first, second], {
      maxVideos: 10,
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    expect(kept.selected.map((c) => c.youtubeId)).toEqual([
      "z-last-in-source",
      "a-first-in-source",
    ]);

    expect(applyFilters([], { maxVideos: 10 })).toEqual({ selected: [], skipped: [] });
  });

  it("adds -<id> to a skipped slug that collides with an earlier skipped slug", () => {
    const one = candidate({ youtubeId: "id-one", title: "Same Title", published: "2020-01-01" });
    const two = candidate({ youtubeId: "id-two", title: "Same Title", published: "2020-01-01" });

    const result = applyFilters([one, two], {
      maxVideos: 10,
      dateFrom: "2026-01-01",
    });

    expect(result.skipped.map((s) => s.slug)).toEqual([
      "same-title",
      "same-title-id-two",
    ]);
  });
});

describe("estimateCalls / estimateMinutes (INGEST-03)", () => {
  it("uses selected + 6 + ceil(selected / 5) with the locked boundaries", () => {
    expect(estimateCalls(0)).toBe(6);
    expect(estimateCalls(1)).toBe(8);
    expect(estimateCalls(5)).toBe(12);
    expect(estimateCalls(6)).toBe(14);
    for (const n of [0, 1, 2, 5, 6, 7, 10, 200]) {
      expect(Number.isInteger(estimateCalls(n))).toBe(true);
    }
  });

  it("returns 0 minutes for 0 selected and rounds up otherwise", () => {
    expect(estimateMinutes(0)).toBe(0);
    // 2 * 3 + 9 * 26 = 240 s = 4 min exactly.
    expect(estimateMinutes(2)).toBe(4);
    // 1 * 3 + 8 * 26 = 211 s -> 4 min.
    expect(estimateMinutes(1)).toBe(4);
    for (const n of [1, 2, 5, 6, 200]) {
      expect(Number.isInteger(estimateMinutes(n))).toBe(true);
    }
  });
});
