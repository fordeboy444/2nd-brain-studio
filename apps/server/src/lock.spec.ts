import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InstanceLockManager,
  LockPayloadSchema,
  acquireInstanceLock,
  getLockState,
  releaseInstanceLock,
  setLockManagerForTesting,
} from "./lock.js";

describe("InstanceLockManager", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lock-spec-"));
    lockPath = join(tempDir, ".lock");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("acquires lock when no lock file exists", async () => {
    const manager = new InstanceLockManager({
      lockPath,
      heartbeatMs: 1000,
      staleMs: 3000,
    });

    const state = await manager.acquire();
    expect(state.isReadOnly).toBe(false);
    expect(state.lockHolder?.pid).toBe(process.pid);

    const onDisk = JSON.parse(await readFile(lockPath, "utf8"));
    const parsed = LockPayloadSchema.safeParse(onDisk);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pid).toBe(process.pid);
    }

    await manager.release();
  });

  it("updates heartbeat timestamp on beat()", async () => {
    const manager = new InstanceLockManager({
      lockPath,
      heartbeatMs: 1000,
      staleMs: 3000,
    });

    await manager.acquire();
    const firstPayload = JSON.parse(await readFile(lockPath, "utf8"));

    // Wait slightly to guarantee a different timestamp
    await new Promise((resolve) => setTimeout(resolve, 15));
    await manager.beat();

    const secondPayload = JSON.parse(await readFile(lockPath, "utf8"));
    expect(secondPayload.heartbeatAt).toBeGreaterThanOrEqual(firstPayload.heartbeatAt);

    await manager.release();
  });

  it("detects active lock from another instance and operates in read-only mode", async () => {
    // Write an active lock belonging to a different PID
    const activeLock = {
      pid: 999999,
      host: "another-host",
      startedAt: Date.now() - 5000,
      heartbeatAt: Date.now() - 2000, // 2s old < 30s staleMs
    };
    await writeFile(lockPath, JSON.stringify(activeLock), "utf8");

    const manager = new InstanceLockManager({
      lockPath,
      heartbeatMs: 1000,
      staleMs: 30000,
    });

    const state = await manager.acquire();
    expect(state.isReadOnly).toBe(true);
    expect(state.lockHolder?.pid).toBe(999999);
    expect(state.lockHolder?.host).toBe("another-host");

    // The lock file on disk should NOT have been overwritten
    const onDisk = JSON.parse(await readFile(lockPath, "utf8"));
    expect(onDisk.pid).toBe(999999);

    // Release as read-only should NOT delete the other instance's lock file
    await manager.release();
    const stillThere = JSON.parse(await readFile(lockPath, "utf8"));
    expect(stillThere.pid).toBe(999999);
  });

  it("self-heals and claims ownership when existing lock is stale (>staleMs)", async () => {
    // Write a stale lock (>5s old with staleMs=3000)
    const staleLock = {
      pid: 999999,
      host: "dead-host",
      startedAt: Date.now() - 60000,
      heartbeatAt: Date.now() - 10000,
    };
    await writeFile(lockPath, JSON.stringify(staleLock), "utf8");

    const manager = new InstanceLockManager({
      lockPath,
      heartbeatMs: 1000,
      staleMs: 3000,
    });

    const state = await manager.acquire();
    expect(state.isReadOnly).toBe(false);
    expect(state.lockHolder?.pid).toBe(process.pid);

    const onDisk = JSON.parse(await readFile(lockPath, "utf8"));
    expect(onDisk.pid).toBe(process.pid);

    await manager.release();
  });

  it("self-heals when lock file contains corrupted JSON", async () => {
    await writeFile(lockPath, "invalid-json-content-here!!!", "utf8");

    const manager = new InstanceLockManager({
      lockPath,
      heartbeatMs: 1000,
      staleMs: 3000,
    });

    const state = await manager.acquire();
    expect(state.isReadOnly).toBe(false);
    expect(state.lockHolder?.pid).toBe(process.pid);

    await manager.release();
  });

  it("releases lock cleanly by removing lock file", async () => {
    const manager = new InstanceLockManager({
      lockPath,
      heartbeatMs: 1000,
      staleMs: 3000,
    });

    await manager.acquire();
    await manager.release();

    let exists = true;
    try {
      await readFile(lockPath, "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("works with module-level default manager and helpers", async () => {
    const testManager = new InstanceLockManager({
      lockPath,
      heartbeatMs: 1000,
      staleMs: 3000,
    });
    setLockManagerForTesting(testManager);

    const state = await acquireInstanceLock();
    expect(state.isReadOnly).toBe(false);
    expect(getLockState().isReadOnly).toBe(false);

    await releaseInstanceLock();
  });
});
