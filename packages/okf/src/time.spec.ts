import { describe, expect, it } from "vitest";
import {
  CITATION_OVERLAP_THRESHOLD,
  CITATION_WINDOW_AFTER_SECONDS,
  CITATION_WINDOW_BEFORE_SECONDS,
  citationScore,
  formatTimestamp,
  normalizeCitationText,
  parseTimestamp,
  parseVideoSegments,
} from "./time.js";

/** One long segment whose text contains every significant quote word. */
const LONG_QUOTE_SEGMENT =
  "alpha beta gamma delta epsilon zeta theta iota kappa lambda";

describe("parseTimestamp", () => {
  it("parses H:MM:SS", () => {
    expect(parseTimestamp("0:00:00")).toBe(0);
    expect(parseTimestamp("0:01:00")).toBe(60);
    expect(parseTimestamp("1:02:03")).toBe(3723);
  });

  it("left-pads a two-part timestamp", () => {
    expect(parseTimestamp("02:03")).toBe(123);
  });

  it("left-pads a one-part timestamp", () => {
    expect(parseTimestamp("5")).toBe(5);
  });
});

describe("formatTimestamp", () => {
  it("formats with an unpadded hour and padded minutes and seconds", () => {
    expect(formatTimestamp(0)).toBe("0:00:00");
    expect(formatTimestamp(60)).toBe("0:01:00");
    expect(formatTimestamp(3723)).toBe("1:02:03");
  });

  it("round-trips through parseTimestamp", () => {
    for (const seconds of [0, 5, 60, 3599, 3600, 3723, 86399]) {
      expect(parseTimestamp(formatTimestamp(seconds))).toBe(seconds);
    }
  });
});

describe("normalizeCitationText", () => {
  it("folds uppercase to lowercase", () => {
    expect(normalizeCitationText("Hello WORLD")).toBe("hello world");
  });

  it("turns punctuation into a space", () => {
    expect(normalizeCitationText("don't stop.")).toBe("don t stop");
  });

  it("collapses a whitespace run", () => {
    expect(normalizeCitationText("a   b\n\tc")).toBe("a b c");
  });

  it("removes non-ASCII letters rather than keeping them", () => {
    expect(normalizeCitationText("café naïve")).toBe("caf na ve");
  });
});

describe("parseVideoSegments", () => {
  it("returns two segments with expected seconds and normalized bodies", () => {
    const text =
      "**[0:00:00]** First line!\n\n" +
      "**[0:01:30]** Second, with [brackets] and 42.";
    expect(parseVideoSegments(text)).toEqual([
      { seconds: 0, text: "first line" },
      { seconds: 90, text: "second with brackets and 42" },
    ]);
  });

  it("keeps a bracket and a number inside a body", () => {
    const segments = parseVideoSegments("**[0:00:05]** a [note] at 99");
    expect(segments).toEqual([
      { seconds: 5, text: "a note at 99" },
    ]);
  });

  it("does not match a marker with single asterisks", () => {
    expect(parseVideoSegments("*[0:00:00]* single")).toEqual([]);
  });

  it("completes over a 1 MiB body with one opening marker (T-02-05)", () => {
    const body = "x".repeat(1024 * 1024);
    const segments = parseVideoSegments(`**[0:00:00]** ${body}`);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.seconds).toBe(0);
    expect(segments[0]?.text).toHaveLength(1024 * 1024);
  });
});

describe("citationScore boundaries", () => {
  const longSegment = { seconds: 60, text: LONG_QUOTE_SEGMENT };

  it("scores a verbatim segment quote at its own timestamp as 1", () => {
    expect(
      citationScore("alpha beta gamma delta", [longSegment], LONG_QUOTE_SEGMENT, 60),
    ).toBe(1);
  });

  it("scores one changed word of four as 0.75 and passes", () => {
    const score = citationScore(
      "alpha beta gamma xray",
      [longSegment],
      LONG_QUOTE_SEGMENT,
      60,
    );
    expect(score).toBe(0.75);
    expect(score).toBeGreaterThanOrEqual(CITATION_OVERLAP_THRESHOLD);
  });

  it("scores three changed words of four as 0.25 and fails", () => {
    const score = citationScore(
      "alpha xray yankee zulu",
      [longSegment],
      LONG_QUOTE_SEGMENT,
      60,
    );
    expect(score).toBe(0.25);
    expect(score).toBeLessThan(CITATION_OVERLAP_THRESHOLD);
  });

  it("scores below the threshold when the words exist only outside the window", () => {
    const segments = [
      { seconds: 0, text: LONG_QUOTE_SEGMENT },
      {
        seconds: 600,
        text: "zebra quantum xylophone marmalade orchard",
      },
    ];
    const full = segments.map((segment) => segment.text).join(" ");
    expect(
      citationScore("alpha beta gamma delta", segments, full, 600),
    ).toBe(0);
  });

  it("includes a segment exactly 45 seconds after the cited timestamp", () => {
    // The decoy segment keeps the window text long when the boundary segment
    // is wrongly excluded, so the short-window fallback cannot mask the edge.
    const segments = [
      { seconds: 0, text: LONG_QUOTE_SEGMENT },
      { seconds: 100, text: "zebra quantum xylophone marmalade orchard" },
    ];
    const full = segments.map((segment) => segment.text).join(" ");
    expect(
      citationScore(
        "alpha beta gamma delta",
        segments,
        full,
        0 + CITATION_WINDOW_BEFORE_SECONDS,
      ),
    ).toBe(1);
  });

  it("includes a segment exactly 120 seconds before the cited timestamp", () => {
    const segments = [
      { seconds: 60, text: "zebra quantum xylophone marmalade orchard" },
      { seconds: 120, text: LONG_QUOTE_SEGMENT },
    ];
    const full = segments.map((segment) => segment.text).join(" ");
    expect(
      citationScore(
        "alpha beta gamma delta",
        segments,
        full,
        120 - CITATION_WINDOW_AFTER_SECONDS,
      ),
    ).toBe(1);
  });

  it("excludes a segment 46 seconds after the cited timestamp", () => {
    const segments = [
      { seconds: 0, text: LONG_QUOTE_SEGMENT },
      { seconds: 100, text: "zebra quantum xylophone marmalade orchard" },
    ];
    const full = segments.map((segment) => segment.text).join(" ");
    expect(citationScore("alpha beta gamma delta", segments, full, 46)).toBe(0);
  });

  it("excludes a segment 121 seconds before the cited timestamp", () => {
    const segments = [
      { seconds: 0, text: "zebra quantum xylophone marmalade orchard" },
      { seconds: 121, text: LONG_QUOTE_SEGMENT },
    ];
    const full = segments.map((segment) => segment.text).join(" ");
    expect(citationScore("alpha beta gamma delta", segments, full, 0)).toBe(0);
  });

  it("falls back to the whole transcript when the window text is 40 characters or shorter", () => {
    const segments = [{ seconds: 0, text: "short" }];
    expect(
      citationScore("alpha epsilon", segments, "alpha epsilon appears here", 0),
    ).toBe(1);
  });

  it("returns 1 for a quote with only words shorter than four characters", () => {
    expect(citationScore("the a of", [], "", 0)).toBe(1);
  });

  it("counts a repeated word per occurrence, so an absent word twice scores 0", () => {
    expect(
      citationScore("absent absent", [], "other words only", null),
    ).toBe(0);
  });

  it("uses the whole transcript when the timestamp is null", () => {
    expect(
      citationScore("alpha beta", [], "an alpha beta page", null),
    ).toBe(1);
  });
});
