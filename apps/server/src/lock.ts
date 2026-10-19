/**
 * Single-instance lock manager (OPS-06).
 *
 * Guarantees that only one container instance operates as the active writer
 * (running background jobs, writing files/settings, reindexing).
 * A secondary instance detects the active lock and runs in read-only mode.
 *
 * Lock file layout (.lock):
 * {
 *   pid: number,
 *   host: string,
 *   startedAt: number,
 *   heartbeatAt: number
 * }
 *
 * Refresh interval: 10,000ms
 * Stale threshold: 30,000ms
 */
import { unlinkSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import pino from "pino";
import { z } from "zod";
import { config } from "./config.js";
import { writeJsonAtomic } from "./http/writeAtomic.js";

const log = pino({ name: "instance-lock" });

export const LockPayloadSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string().min(1),
  startedAt: z.number().int().positive(),
  heartbeatAt: z.number().int().positive(),
});

export type LockPayload = z.infer<typeof LockPayloadSchema>;

export interface LockState {
  isReadOnly: boolean;
  lockHolder: LockPayload | null;
}

export interface LockManagerOptions {
  lockPath?: string;
  heartbeatMs?: number;
  staleMs?: number;
}

export class InstanceLockManager {
  readonly lockPath: string;
  readonly heartbeatMs: number;
  readonly staleMs: number;

  private isReadOnly: boolean = false;
  private lockHolder: LockPayload | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isAcquired: boolean = false;
  private exitHandlerRegistered: boolean = false;

  constructor(options: LockManagerOptions = {}) {
    this.lockPath =
      options.lockPath ??
      process.env.LOCK_PATH ??
      join(process.env.VAULT_ROOT ?? config.vaultRoot, ".lock");
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.staleMs = options.staleMs ?? 30_000;
  }

  getLockState(): LockState {
    return {
      isReadOnly: this.isReadOnly,
      lockHolder: this.lockHolder,
    };
  }

  /**
   * Attempt to acquire the lock.
   * If a valid, non-stale lock exists held by another process/host,
   * this instance assumes read-only mode.
   * If no lock exists or the existing lock is stale (>staleMs),
   * this instance acquires the lock and starts the heartbeat.
   */
  async acquire(): Promise<LockState> {
    const existing = await this.readLockFile();
    const now = Date.now();

    if (existing !== null) {
      const isStale = now - existing.heartbeatAt > this.staleMs;
      const isOurProcess =
        existing.pid === process.pid && existing.host === hostname();

      if (!isStale && !isOurProcess) {
        // Active instance exists
        this.isReadOnly = true;
        this.lockHolder = existing;
        this.isAcquired = false;
        log.info(
          { existing },
          "Secondary instance detected active lock; operating in read-only mode",
        );
        return this.getLockState();
      }

      if (isStale) {
        log.warn(
          { existing, now, diff: now - existing.heartbeatAt },
          "Stale lock detected; self-healing by claiming lock",
        );
      }
    }

    // Acquire lock
    const payload: LockPayload = {
      pid: process.pid,
      host: hostname(),
      startedAt: now,
      heartbeatAt: now,
    };

    await mkdir(dirname(this.lockPath), { recursive: true });
    await writeJsonAtomic(this.lockPath, payload);

    this.isReadOnly = false;
    this.lockHolder = payload;
    this.isAcquired = true;

    this.startHeartbeat();
    this.registerExitHandlers();

    return this.getLockState();
  }

  /**
   * Release the lock and stop the heartbeat.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (this.isAcquired) {
      try {
        await unlink(this.lockPath);
      } catch {
        // Ignore if already deleted
      }
      this.isAcquired = false;
      this.lockHolder = null;
    }
  }

  /** Force refresh heartbeat manually (useful for testing or tick). */
  async beat(): Promise<void> {
    if (!this.isAcquired) return;
    try {
      const payload: LockPayload = {
        pid: process.pid,
        host: hostname(),
        startedAt: this.lockHolder?.startedAt ?? Date.now(),
        heartbeatAt: Date.now(),
      };
      await writeJsonAtomic(this.lockPath, payload);
      this.lockHolder = payload;
    } catch (err) {
      log.error({ err }, "Failed to write heartbeat to lock file");
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.beat();
    }, this.heartbeatMs);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async readLockFile(): Promise<LockPayload | null> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const json = JSON.parse(raw);
      const parsed = LockPayloadSchema.safeParse(json);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private registerExitHandlers(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;

    const cleanup = () => {
      if (this.isAcquired) {
        this.stopHeartbeat();
        try {
          unlinkSync(this.lockPath);
        } catch {
          // ignore
        }
      }
    };

    process.once("exit", cleanup);
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
    process.once("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
  }
}

// Module-level default instance
let defaultLockManager = new InstanceLockManager();

export function getDefaultLockManager(): InstanceLockManager {
  return defaultLockManager;
}

export function setLockManagerForTesting(manager: InstanceLockManager): void {
  defaultLockManager = manager;
}

export function getLockState(): LockState {
  return defaultLockManager.getLockState();
}

export async function acquireInstanceLock(): Promise<LockState> {
  return defaultLockManager.acquire();
}

export async function releaseInstanceLock(): Promise<void> {
  return defaultLockManager.release();
}
