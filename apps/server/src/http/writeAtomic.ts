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
 * Write `text` verbatim, atomically. When `mode` is given it is applied to the
 * temp file with `chmod` *before* the rename, so the target is never briefly
 * readable with the wrong permissions (the cookie file is 0600).
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
  const fh = await open(tmp, "w");
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
