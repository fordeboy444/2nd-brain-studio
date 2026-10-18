import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSseFrame, parseLastEventId, streamJobEvents } from "./events.js";
import { appendEvent } from "./store.js";
import type { JobEvent } from "./types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "events-spec-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function appFor(options: { pollMs?: number; keepaliveMs?: number }): Hono {
  const app = new Hono();
  app.get("/events", (c) =>
    streamJobEvents(c, dir, parseLastEventId(c.req.header("last-event-id")), options),
  );
  return app;
}

/** Every `id:` value in the received text, in arrival order. */
function frameIds(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

/**
 * Read a stream until `complete` is true, then cancel the reader so the route's
 * `onAbort` runs and the test leaves no open handle.
 */
async function readSse(
  res: Response,
  complete: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const body = res.body;
  if (body === null) throw new Error("response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (!complete(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`SSE read timed out; received ${JSON.stringify(text)}`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SSE read timed out")), remaining);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

describe("parseLastEventId", () => {
  it("accepts a non-negative integer", () => {
    expect(parseLastEventId("30")).toBe(30);
    expect(parseLastEventId("0")).toBe(0);
    expect(parseLastEventId(" 30 ")).toBe(30);
  });

  it("falls back to 0 for absent, negative, fractional, non-numeric or oversized values", () => {
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId(null)).toBe(0);
    expect(parseLastEventId("")).toBe(0);
    expect(parseLastEventId("-1")).toBe(0);
    expect(parseLastEventId("1.5")).toBe(0);
    expect(parseLastEventId("1e3")).toBe(0);
    expect(parseLastEventId("abc")).toBe(0);
    expect(parseLastEventId("9".repeat(65))).toBe(0);
  });
});

describe("formatSseFrame (T-03-07)", () => {
  it("frames id, event and data in that order, ending with a blank line", () => {
    const event: JobEvent = {
      seq: 4,
      type: "error",
      data: { message: "boom" },
      at: "2026-10-18T10:00:00.000Z",
    };
    expect(formatSseFrame(event)).toBe(
      'id: 4\nevent: error\ndata: {"message":"boom"}\n\n',
    );
  });

  it("JSON-escapes a literal newline so it produces exactly one data line", () => {
    const event: JobEvent = {
      seq: 7,
      type: "error",
      data: { message: "line one\nline two" },
      at: "2026-10-18T10:00:00.000Z",
    };
    const frame = formatSseFrame(event);

    const dataLines = frame.split("\n").filter((line) => line.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toBe('data: {"message":"line one\\nline two"}');
    // A forged event line cannot survive inside the JSON-encoded data.
    expect(frame.match(/^event: /gm)).toHaveLength(1);
  });
});

describe("streamJobEvents (API-05, API-06)", () => {
  it("replays seq 31..50 in order after Last-Event-ID: 30, one id line each", async () => {
    for (let i = 0; i < 50; i += 1) {
      await appendEvent(dir, "unit", { n: i });
    }
    const app = appFor({ pollMs: 1000, keepaliveMs: 60_000 });

    const res = await app.request("/events", { headers: { "last-event-id": "30" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const text = await readSse(res, (received) => frameIds(received).length >= 20);

    expect(frameIds(text)).toEqual(
      Array.from({ length: 20 }, (_, index) => 31 + index),
    );
    expect(text.match(/^id: /gm)).toHaveLength(20);
    // Replay completed before any keepalive was due to start.
    expect(text).not.toContain(":keepalive");
  });

  it("opens a stream for a job with no events and emits only keepalive", async () => {
    const app = appFor({ pollMs: 1000, keepaliveMs: 20 });

    const res = await app.request("/events");
    expect(res.status).toBe(200);

    const text = await readSse(res, (received) => received.includes(":keepalive"));
    expect(text.startsWith(":keepalive")).toBe(true);
    expect(text).not.toContain("id:");
    expect(text).not.toContain("data:");
  });

  it("starts the keepalive only after replay completes, never between frames", async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendEvent(dir, "stage", { n: i });
    }
    const app = appFor({ pollMs: 1000, keepaliveMs: 10 });

    const res = await app.request("/events");
    const text = await readSse(res, (received) => received.includes(":keepalive"));

    const firstKeepalive = text.indexOf(":keepalive");
    const lastReplayed = text.lastIndexOf("id: 5");
    expect(lastReplayed).toBeGreaterThanOrEqual(0);
    expect(firstKeepalive).toBeGreaterThan(lastReplayed);
    expect(frameIds(text)).toEqual([1, 2, 3, 4, 5]);
  });

  it("tails events appended after the replay without skipping or duplicating seq", async () => {
    for (let i = 0; i < 3; i += 1) {
      await appendEvent(dir, "job", { n: i });
    }
    const app = appFor({ pollMs: 10, keepaliveMs: 60_000 });

    const res = await app.request("/events", { headers: { "last-event-id": "1" } });
    const reading = readSse(res, (received) => frameIds(received).length >= 3);

    // Let the replay settle, then append a live event.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await appendEvent(dir, "done", { status: "completed" });

    const text = await reading;
    expect(frameIds(text)).toEqual([2, 3, 4]);
  });
});
