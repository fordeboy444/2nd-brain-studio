import { appendFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonAtomic, writeTextAtomic } from "../http/writeAtomic.js";
import {
  appendEvent,
  createJobRecord,
  isJobId,
  jobDir,
  listJobs,
  newJobId,
  readEvents,
  readJob,
  requestCancel,
  withJobLock,
  writeJob,
} from "./store.js";
import type { JobSettings } from "./types.js";

const SETTINGS: JobSettings = {
  maxVideos: 10,
  filters: {},
  fetch: { concurrency: 1 },
  llm: { model: "test" },
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "store-spec-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeAtomic (T-03-02)", () => {
  it("writes a parseable JSON target and leaves no temp sibling", async () => {
    const target = join(root, "nested", "job.json");
    await writeJsonAtomic(target, { a: 1, nested: { b: "x" } });

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      a: 1,
      nested: { b: "x" },
    });
    const names = await readdir(join(root, "nested"));
    expect(names).toEqual(["job.json"]);
    expect(names.some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("applies the requested mode before the rename", async () => {
    const target = join(root, "cookie.txt");
    await writeTextAtomic(target, "secret\n", 0o600);
    const mode = (await stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readFile(target, "utf8")).toBe("secret\n");
  });

  it("writes text verbatim when no mode is given", async () => {
    const target = join(root, "page.md");
    await writeTextAtomic(target, "---\ntype: x\n---\n\nbody\n");
    expect(await readFile(target, "utf8")).toBe("---\ntype: x\n---\n\nbody\n");
  });
});

describe("events.ndjson", () => {
  it("numbers events from 1 and replays in order after a seq", async () => {
    const dir = join(root, "job");
    for (let i = 0; i < 5; i += 1) {
      await appendEvent(dir, "stage", { n: i });
    }

    const all = await readEvents(dir, 0);
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all[0]?.type).toBe("stage");

    const after = await readEvents(dir, 3);
    expect(after.map((event) => event.seq)).toEqual([4, 5]);
  });

  it("ignores an unfinished trailing line and does not throw", async () => {
    const dir = join(root, "job");
    await appendEvent(dir, "job", { status: "running" });
    await appendEvent(dir, "stage", { status: "started" });
    await appendFile(join(dir, "events.ndjson"), '{"seq":3,"type":"unit"', "utf8");

    const events = await readEvents(dir, 0);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    // The next append still continues from the last complete line.
    const next = await appendEvent(dir, "done", { status: "completed" });
    expect(next.seq).toBe(3);
  });

  it("notifies subscribers only after the event is durable", async () => {
    const dir = join(root, "job");
    const seen: number[] = [];
    const onDisk: number[] = [];
    const { onEventAppended } = await import("./store.js");
    const unsubscribe = onEventAppended(dir, (event) => {
      seen.push(event.seq);
    });
    await appendEvent(dir, "unit", { slug: "a" });
    onDisk.push(...(await readEvents(dir, 0)).map((event) => event.seq));
    unsubscribe();
    await appendEvent(dir, "unit", { slug: "b" });

    expect(seen).toEqual([1]);
    expect(onDisk).toEqual([1]);
    expect((await readEvents(dir, 0)).map((event) => event.seq)).toEqual([1, 2]);
  });
});

describe("job ids (T-03-01)", () => {
  it("accepts only j_<YYYYMMDD>_<6 lowercase hex>", () => {
    expect(isJobId("j_20261018_00a1ff")).toBe(true);
    expect(isJobId("../x")).toBe(false);
    expect(isJobId("")).toBe(false);
    expect(isJobId("j_20261018_00a1f")).toBe(false);
    expect(isJobId("j_20261018_00A1FF")).toBe(false);
    expect(isJobId("j_2026-10-18_00a1ff")).toBe(false);
  });

  it("formats a local YYYYMMDD and six hex characters", () => {
    const id = newJobId(new Date(2026, 9, 18, 12, 0, 0), () => 0.5);
    expect(id).toMatch(/^j_20261018_[0-9a-f]{6}$/);
  });

  it("rejects an invalid id before building a path", () => {
    expect(() => jobDir(root, "../x")).toThrow("invalid job id");
    expect(() => jobDir(root, "a/b")).toThrow("invalid job id");
  });

  it("builds the vault-scoped directory", () => {
    expect(jobDir(root, "j_20261018_00a1ff")).toBe(
      join(root, ".okf", "jobs", "j_20261018_00a1ff"),
    );
  });
});

describe("job records", () => {
  it("round-trips a record and lists newest last", async () => {
    const first = createJobRecord({
      id: "j_20261018_000001",
      vaultId: "v",
      kind: "youtube",
      input: { url: "https://youtube.com/@x" },
      settings: SETTINGS,
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    const second = createJobRecord({
      id: "j_20261018_000002",
      vaultId: "v",
      kind: "web",
      input: { url: "https://example.com" },
      settings: SETTINGS,
      createdAt: "2026-10-18T09:00:00.000Z",
    });
    await writeJob(root, first);
    await writeJob(root, second);

    expect(await readJob(root, first.id)).toEqual(first);
    const listed = await listJobs(root);
    expect(listed.map((job) => job.id)).toEqual([second.id, first.id]);
  });

  it("skips one corrupt record and keeps scanning", async () => {
    const good = createJobRecord({
      id: "j_20261018_000003",
      vaultId: "v",
      kind: "youtube",
      input: { url: "https://youtube.com/@x" },
      settings: SETTINGS,
    });
    await writeJob(root, good);
    await writeTextAtomic(join(jobDir(root, "j_20261018_000004"), "job.json"), "{oops");

    const listed = await listJobs(root);
    expect(listed.map((job) => job.id)).toEqual([good.id]);
  });

  it("sets cancelRequested atomically", async () => {
    const job = createJobRecord({
      id: "j_20261018_000005",
      vaultId: "v",
      kind: "youtube",
      input: { url: "https://youtube.com/@x" },
      settings: SETTINGS,
    });
    await writeJob(root, job);
    await requestCancel(root, job.id);
    expect((await readJob(root, job.id)).cancelRequested).toBe(true);
  });
});

describe("cancel serialization (CR-04)", () => {
  it("never loses a cancel behind a concurrent read-modify-write", async () => {
    const job = createJobRecord({
      id: "j_20261018_000006",
      vaultId: "v",
      kind: "youtube",
      input: { url: "https://youtube.com/@x" },
      settings: SETTINGS,
    });
    await writeJob(root, job);

    let snapshotTaken: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The runner's persist shape: read the record, pause, write it back.
    const runnerWrite = withJobLock(root, job.id, async () => {
      const snapshot = await readJob(root, job.id);
      snapshotTaken();
      await gate;
      await writeJob(root, { ...snapshot, updatedAt: "2026-10-18T10:00:01.000Z" });
    });

    await reached;
    const cancel = requestCancel(root, job.id);
    // Let the cancel reach the lock and queue behind the paused writer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([runnerWrite, cancel]);

    expect((await readJob(root, job.id)).cancelRequested).toBe(true);
  });
});
