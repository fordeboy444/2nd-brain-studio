/**
 * The SSE stream helper (API-05, API-06).
 *
 * The event log on disk is the replay source, never an in-memory history: a
 * subscriber that reconnects with `Last-Event-ID: n` gets every event with
 * `seq > n` in order, then live events as they are appended.
 *
 * Frame shape is fixed: `id: <seq>`, `event: <type>`, `data: <json>` and a
 * blank line. The data is `JSON.stringify`d, so a newline inside event data is
 * escaped and can never start a new frame (T-03-07).
 *
 * `:keepalive` carries no id and does not advance `Last-Event-ID`; it starts
 * only after replay completes, so no keepalive is interleaved between replayed
 * frames.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { readEvents } from "./store.js";
import type { JobEvent } from "./types.js";

/** The longest `Last-Event-ID` accepted; anything longer is treated as absent. */
const MAX_LAST_EVENT_ID_LENGTH = 64;

export interface SseOptions {
  /** How often the tail re-reads `events.ndjson`. */
  pollMs?: number;
  /** How often a `:keepalive` comment is written. */
  keepaliveMs?: number;
}

/**
 * A non-negative integer from the `Last-Event-ID` header, or 0 when absent,
 * negative, fractional, non-numeric or oversized. 0 means "replay everything".
 */
export function parseLastEventId(header: string | null | undefined): number {
  if (header === null || header === undefined) return 0;
  const trimmed = header.trim();
  if (trimmed === "" || trimmed.length > MAX_LAST_EVENT_ID_LENGTH) return 0;
  // Digits only: rejects "-1", "1.5", "1e3" and "abc" in one check.
  if (!/^\d+$/.test(trimmed)) return 0;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** One complete SSE frame. `data` is JSON, so it is always a single line. */
export function formatSseFrame(event: JobEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** The part of Hono's SSE stream this helper needs. */
export interface SseWriter {
  readonly aborted: boolean;
  write(chunk: string): Promise<unknown>;
}

/**
 * Write one frame, or stop the stream when the client has gone.
 *
 * A write can reject when the client disconnects between the `aborted` check
 * and the write. The rejection is caught here: an escaped rejection would be
 * unhandled, and Node 22 turns an unhandled rejection into a process exit.
 * No write error is recoverable, so every failure stops the stream.
 */
export async function writeFrameSafely(
  stream: SseWriter,
  frame: string,
  stop: () => void,
): Promise<boolean> {
  if (stream.aborted) {
    stop();
    return false;
  }
  try {
    await stream.write(frame);
    return true;
  } catch {
    stop();
    return false;
  }
}

/**
 * Replay `events.ndjson` after `lastSeq`, then tail it, writing a `:keepalive`
 * comment periodically. Resolves when the client disconnects.
 */
export function streamJobEvents(
  c: Context,
  jobDirPath: string,
  lastSeq: number,
  options: SseOptions = {},
): Response {
  const pollMs = options.pollMs ?? 250;
  const keepaliveMs = options.keepaliveMs ?? 15_000;

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    let cursor = lastSeq;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let reading = false;
    let stopped = false;

    const stop = (): void => {
      stopped = true;
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
      pollTimer = undefined;
      keepaliveTimer = undefined;
    };

    try {
      // Replay first: the keepalive timer is created only after this loop, so a
      // replayed frame can never be interleaved with a keepalive.
      for (const event of await readEvents(jobDirPath, lastSeq)) {
        if (stopped) return;
        if (!(await writeFrameSafely(stream, formatSseFrame(event), stop))) return;
        cursor = event.seq;
      }

      pollTimer = setInterval(() => {
        if (stopped || reading) return;
        reading = true;
        void (async () => {
          try {
            const fresh = await readEvents(jobDirPath, cursor);
            for (const event of fresh) {
              if (stopped) return;
              if (!(await writeFrameSafely(stream, formatSseFrame(event), stop))) return;
              cursor = event.seq;
            }
          } catch {
            // A transient read error must not tear down a live stream; the next
            // poll re-reads the same cursor.
          } finally {
            reading = false;
          }
        })();
      }, pollMs);

      keepaliveTimer = setInterval(() => {
        if (stopped) return;
        // Never `void stream.write(...)`: a rejected keepalive would be an
        // unhandled rejection. The helper stops the stream on any write error.
        void writeFrameSafely(stream, ":keepalive\n\n", stop);
      }, keepaliveMs);

      if (c.req.raw.signal.aborted) {
        stop();
        return;
      }

      // Stay open until the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          stop();
          resolve();
        });
        c.req.raw.signal.addEventListener(
          "abort",
          () => {
            stop();
            resolve();
          },
          { once: true },
        );
      });
    } finally {
      stop();
    }
  });
}
