import { describe, expect, it } from "vitest";
import {
  InvalidSourceUrlError,
  isYouTubeChannelUrl,
  normalizeChannelUrl,
} from "./urls.js";

describe("normalizeChannelUrl (INGEST-01)", () => {
  it("normalizes @handle, /channel/, /c/ and /user/ to the /videos tab", () => {
    expect(normalizeChannelUrl("https://www.youtube.com/@colemedin")).toBe(
      "https://www.youtube.com/@colemedin/videos",
    );
    expect(normalizeChannelUrl("https://youtube.com/channel/UCabc123")).toBe(
      "https://www.youtube.com/channel/UCabc123/videos",
    );
    expect(normalizeChannelUrl("https://m.youtube.com/c/SomeName")).toBe(
      "https://www.youtube.com/c/SomeName/videos",
    );
    expect(normalizeChannelUrl("https://youtube.com/user/some-user")).toBe(
      "https://www.youtube.com/user/some-user/videos",
    );
  });

  it("is idempotent once the URL is normalized", () => {
    const once = normalizeChannelUrl("https://youtube.com/@demo");
    expect(normalizeChannelUrl(once)).toBe(once);
  });

  it("upgrades http to https and drops the query and fragment", () => {
    expect(
      normalizeChannelUrl("http://www.youtube.com/@demo/videos?view=0&sort=dd#top"),
    ).toBe("https://www.youtube.com/@demo/videos");
  });

  it("accepts a trailing slash on the path", () => {
    expect(normalizeChannelUrl("https://youtube.com/user/demo/")).toBe(
      "https://www.youtube.com/user/demo/videos",
    );
  });

  it("rejects a non-YouTube host, a non-http protocol and an oversized URL", () => {
    expect(() => normalizeChannelUrl("https://example.com/@x")).toThrow(InvalidSourceUrlError);
    expect(() => normalizeChannelUrl("ftp://youtube.com/@x")).toThrow(InvalidSourceUrlError);
    expect(() => normalizeChannelUrl("https://youtube.com/watch?v=abcdefghijk")).toThrow(
      InvalidSourceUrlError,
    );
    expect(() => normalizeChannelUrl("https://youtube.com/playlist?list=PL123")).toThrow(
      InvalidSourceUrlError,
    );
    expect(() => normalizeChannelUrl("https://youtu.be/abcdefghijk")).toThrow(
      InvalidSourceUrlError,
    );
    expect(() => normalizeChannelUrl("not a url")).toThrow(InvalidSourceUrlError);
    expect(() => normalizeChannelUrl("")).toThrow(InvalidSourceUrlError);

    const oversized = `https://youtube.com/@${"a".repeat(3000)}`;
    expect(oversized.length).toBeGreaterThan(2048);
    expect(() => normalizeChannelUrl(oversized)).toThrow(InvalidSourceUrlError);
  });

  it("does not accept a channel path with extra segments", () => {
    expect(() => normalizeChannelUrl("https://youtube.com/@demo/featured")).toThrow(
      InvalidSourceUrlError,
    );
    expect(() => normalizeChannelUrl("https://youtube.com/@demo/videos/extra")).toThrow(
      InvalidSourceUrlError,
    );
  });

  it("isYouTubeChannelUrl is the boolean wrapper and never throws", () => {
    expect(isYouTubeChannelUrl("https://youtube.com/@demo")).toBe(true);
    expect(isYouTubeChannelUrl("https://example.com/@demo")).toBe(false);
    expect(isYouTubeChannelUrl("")).toBe(false);
  });
});
