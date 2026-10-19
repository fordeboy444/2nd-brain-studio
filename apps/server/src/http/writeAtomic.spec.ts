import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The creation mode matters as much as the final mode: a cookie temp file
 * that is chmodded after the body was written is briefly world-readable, and
 * a SIGKILL between `open` and `chmod` would leave it that way permanently.
 * Capture the mode passed to the first `open` and prove it is 0600.
 */
const { openModes } = vi.hoisted(() => ({
  openModes: [] as Array<number | undefined>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open(path: string, flags: string, mode?: number) {
      openModes.push(mode);
      return actual.open(path, flags, mode);
    },
  };
});

import { writeTextAtomic } from "./writeAtomic.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "write-atomic-spec-"));
  openModes.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeTextAtomic (T-03-02, T-03-25)", () => {
  it("creates the cookie temp file at 0600 before the body is written", async () => {
    const target = join(root, "youtube-cookie.txt");
    await writeTextAtomic(target, "session=secret\n", 0o600);

    // The first open is the temp file at the final mode; the second is the
    // parent directory, opened read-only to fsync the rename (WR-03).
    expect(openModes).toEqual([0o600, undefined]);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("uses the default creation mode for ordinary artifacts", async () => {
    await writeTextAtomic(join(root, "artifact.md"), "public\n");

    expect(openModes).toEqual([0o644, undefined]);
    expect((await stat(join(root, "artifact.md"))).mode & 0o777).toBe(0o644);
  });
});
