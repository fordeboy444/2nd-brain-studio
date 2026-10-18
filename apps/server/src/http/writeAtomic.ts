/**
 * The atomic write helper (T-03-02).
 *
 * Every job artifact is written the same way: a sibling temp file, the full
 * payload, `FileHandle.sync()`, close, then a rename over the target. The
 * rename is the visibility gate — a reader either sees the previous file or the
 * complete new one, never a half-written page.
 *
 * `fsync` is the part the Phase 1 registry helper (`writeRegistryAtomic`)
 * omits: without it a crash can leave the renamed file's *contents* unflushed,
 * so the name exists but the bytes are zero-length or partial.
 *
 * The temp name carries the pid and a per-process counter, so two writes in the
 * same millisecond (and two processes) never collide on the source path.
 */
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let counter = 0;

/** A sibling of `target` so the final `rename` never crosses a filesystem. */
function tempPath(target: string): string {
  counter += 1;
  return join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${counter}`);
}

/**
 * Write `value` as pretty JSON plus a trailing newline, atomically.
 * Creates the parent directory when it does not exist.
 */
export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Write `text` verbatim, atomically. When `mode` is given it is the file
 * creation mode of the temp file, so the bytes are never broader than the
 * requested permissions even for an instant; the `chmod` before the rename
 * then pins the exact final mode (the cookie file is 0600).
 */
export async function writeTextAtomic(
  target: string,
  text: string,
  mode?: number,
): Promise<void> {
  await writeAtomic(target, text, mode);
}

async function writeAtomic(target: string, text: string, mode?: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = tempPath(target);
  // Create at the final mode instead of Node's default (0o666 masked by the
  // umask): a SIGKILL between open and chmod can no longer leave a
  // world-readable temp file holding the live YouTube session cookie.
  const fh = await open(tmp, "w", mode ?? 0o644);
  try {
    await fh.write(text);
    if (mode !== undefined) await fh.chmod(mode);
    // Durability, not just ordering: without sync the rename can be visible
    // while the data blocks are still in the page cache.
    await fh.sync();
  } catch (error) {
    await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await fh.close();
  await rename(tmp, target);
}
