import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the two fs functions the file route + jail call, while delegating to
// the real implementation so every other test (and vault creation) works. The
// empty-path test reads these spies to prove the jail short-circuits before any
// filesystem call. vi.mock is hoisted above the imports above; the factory only
// uses `importActual` and `vi.fn` (no late bindings).
vi.mock("node:fs/promises", async (importActual) => {
  const actual = (await importActual()) as typeof import("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    realpath: vi.fn(actual.realpath),
  };
});

const ORIG_ENV = { ...process.env };

let root = "";
let webDist = "";

async function reload() {
  vi.resetModules();
  return (await import("./file.js")) as typeof import("./file.js");
}

async function reloadApp() {
  vi.resetModules();
  return (await import("../http/app.js")) as typeof import("../http/app.js");
}

beforeEach(async () => {
  delete process.env.VAULT_ROOT;
  root = await mkdtemp(join(tmpdir(), "fileroutes-"));
  process.env.VAULT_ROOT = root;
  // The app needs an index.html for the SPA fallback; create a minimal one in
  // a directory this spec owns, so parallel specs never share or delete a
  // real build under apps/web/dist.
  webDist = await mkdtemp(join(tmpdir(), "fileroutes-web-"));
  process.env.WEB_DIST_DIR = webDist;
  await writeFile(
    join(webDist, "index.html"),
    "<!doctype html><html><body><div id=root></div></body></html>",
  );
});

afterEach(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
  await rm(webDist, { recursive: true, force: true });
});

async function createVaultViaApi(app: Awaited<ReturnType<typeof reloadApp>>["app"], name: string): Promise<string> {
  const res = await app.request("/api/vaults", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id as string;
}

async function sha256(bytes: Buffer | string): Promise<string> {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return createHash("sha256").update(buf).digest("hex");
}

describe("GET /api/file + PUT /api/file round trip", () => {
  it("reads a file, writes the identical content back, asserts 200 and unchanged SHA-256 on disk", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Round Trip");
    // Seed a file directly on disk inside the vault dir.
    const vaultDir = join(root, vaultId);
    const relPath = "concepts/note.md";
    const original = "# Hello\n\nA citation-backed note.\n";
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(join(vaultDir, relPath), original, "utf8");

    // GET
    const getRes = await app.request(
      `/api/file?vault=${vaultId}&path=${encodeURIComponent(relPath)}`,
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.path).toBe(relPath);
    expect(getBody.content).toBe(original);
    const baseHash = getBody.baseHash as string;
    expect(baseHash).toBe(await sha256(Buffer.from(original, "utf8")));

    // PUT identical content with the returned baseHash
    const putRes = await app.request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault: vaultId, path: relPath, content: original, baseHash }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.path).toBe(relPath);

    // Third read: byte-identical.
    const get2 = await app.request(
      `/api/file?vault=${vaultId}&path=${encodeURIComponent(relPath)}`,
    );
    const get2Body = await get2.json();
    expect(get2Body.content).toBe(original);
    expect(get2Body.baseHash).toBe(baseHash);

    // On-disk hash unchanged.
    const disk = await readFile(join(vaultDir, relPath));
    expect(await sha256(disk)).toBe(baseHash);
  });

  it("stale baseHash: mutates the file between read and write, asserts 409 with currentContent/currentHash and untouched disk", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Stale");
    const vaultDir = join(root, vaultId);
    const relPath = "concepts/stale.md";
    const original = "first content\n";
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(join(vaultDir, relPath), original, "utf8");

    const getRes = await app.request(
      `/api/file?vault=${vaultId}&path=${encodeURIComponent(relPath)}`,
    );
    const baseHash = (await getRes.json()).baseHash as string;

    // Mutate on disk between the read and the write.
    const mutated = "someone else wrote here\n";
    await writeFile(join(vaultDir, relPath), mutated, "utf8");
    const mutatedHash = await sha256(Buffer.from(mutated, "utf8"));

    const putRes = await app.request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault: vaultId, path: relPath, content: original, baseHash }),
    });
    expect(putRes.status).toBe(409);
    const putBody = await putRes.json();
    expect(putBody.currentContent).toBe(mutated);
    expect(putBody.currentHash).toBe(mutatedHash);

    // Disk untouched by the rejected write.
    const disk = await readFile(join(vaultDir, relPath), "utf8");
    expect(disk).toBe(mutated);
  });

  it("baseHash null on an existing path returns 409 and leaves the file untouched", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Null Hash");
    const vaultDir = join(root, vaultId);
    const relPath = "concepts/existing.md";
    const original = "already here\n";
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(join(vaultDir, relPath), original, "utf8");

    const putRes = await app.request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault: vaultId, path: relPath, content: "new", baseHash: null }),
    });
    expect(putRes.status).toBe(409);
    const disk = await readFile(join(vaultDir, relPath), "utf8");
    expect(disk).toBe(original);
  });

  it("baseHash null on a non-existent path creates the file (200)", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Create");
    const relPath = "concepts/new-file.md";
    const content = "freshly created\n";

    const putRes = await app.request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault: vaultId, path: relPath, content, baseHash: null }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.baseHash).toBe(await sha256(Buffer.from(content, "utf8")));
    const disk = await readFile(join(root, vaultId, relPath), "utf8");
    expect(disk).toBe(content);
  });

  it("no response body contains an absolute host path; a jail rejection returns a fixed message with no '/'", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Path Leak");
    const relPath = "concepts/legit.md";
    await mkdir(join(root, vaultId, "concepts"), { recursive: true });
    await writeFile(join(root, vaultId, relPath), "ok\n", "utf8");

    // Traversal probe -> 400 fixed message.
    const res = await app.request(
      `/api/file?vault=${vaultId}&path=${encodeURIComponent("../escape.md")}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    // The fixed message must not reveal the host path.
    expect(JSON.stringify(body)).not.toContain(root);
    expect(JSON.stringify(body)).not.toContain(join(root, vaultId));
    // The message is a fixed string that contains no '/' (no path leakage).
    expect(body.message).toBe("Invalid path.");
    expect(body.message).not.toContain("/");
  });

  it("an unknown vault id returns 404", async () => {
    const { app } = await reloadApp();
    const res = await app.request(`/api/file?vault=ghost&path=note.md`);
    expect(res.status).toBe(404);
  });

  it("a missing file returns 404", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Missing File");
    const res = await app.request(
      `/api/file?vault=${vaultId}&path=${encodeURIComponent("concepts/absent.md")}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("hashContent", () => {
  it("hashes raw bytes, not a re-serialised string (newline round trip)", async () => {
    const { hashContent } = await reload();
    const text = "line1\nline2\r\nline3\n";
    const buf = Buffer.from(text, "utf8");
    // A re-serialised string that normalises CRLF would differ; hashContent
    // must hash the raw buffer.
    expect(hashContent(buf)).toBe(createHash("sha256").update(buf).digest("hex"));
    // And it must NOT equal the hash of a CRLF-normalised version.
    const normalised = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
    expect(hashContent(buf)).not.toBe(createHash("sha256").update(normalised).digest("hex"));
  });
});

describe("empty path parameter (input-shape rejection boundary)", () => {
  it("an empty `path` query returns 400 and records zero node:fs calls for the path resolution", async () => {
    // The file-level vi.mock("node:fs/promises") wraps readFile/realpath in
    // vi.fn(actual.*) so real behaviour is preserved and calls are recorded.
    // reloadApp() calls vi.resetModules(), which re-runs the factory, so the
    // spies for THIS app instance are the ones the cached mocked module
    // exposes right now — import it to read them.
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Empty Path");
    const vaultDir = join(root, vaultId);

    // Snapshot the spy call counts AFTER vault creation (which itself uses fs
    // via the registry/scaffold) so only calls attributable to the empty-path
    // request are measured.
    const fsMod = await import("node:fs/promises");
    const realpathBefore = vi.mocked(fsMod.realpath).mock.calls.length;
    const readFileBefore = vi.mocked(fsMod.readFile).mock.calls.length;

    // Empty path query.
    const res = await app.request(`/api/file?vault=${vaultId}&path=`);
    expect(res.status).toBe(400);

    // The jail's empty-check (step 1) must short-circuit BEFORE any filesystem
    // call: no new realpath call (the jail never reached realpath(vaultDir)),
    // and no new readFile call on a path under the vault dir (the route never
    // reached the file read). readRegistry's readFile on the registry file is
    // incidental and never touches the vault dir.
    expect(vi.mocked(fsMod.realpath).mock.calls.length).toBe(realpathBefore);
    const newReadCalls = vi.mocked(fsMod.readFile).mock.calls.slice(readFileBefore);
    expect(
      newReadCalls.some(([p]) => typeof p === "string" && p.startsWith(vaultDir)),
    ).toBe(false);
  });

  it("a missing `path` query returns 400", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Missing Path");
    const res = await app.request(`/api/file?vault=${vaultId}`);
    expect(res.status).toBe(400);
  });

  it("an empty `path` in a PUT body returns 400", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Put Empty Path");
    const res = await app.request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault: vaultId, path: "", content: "x", baseHash: null }),
    });
    expect(res.status).toBe(400);
  });
});
describe("cross-origin guard", () => {
  it("refuses a cross-origin PUT and writes nothing", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Guarded Put");
    const res = await app.request("/api/file", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Origin: "http://evil.example",
        "X-Forwarded-Host": "localhost:3010",
      },
      body: JSON.stringify({ vault: vaultId, path: "note.md", content: "x", baseHash: null }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("origin_mismatch");
  });

  it("still serves a cross-origin GET (only mutations are guarded)", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Guarded Get");
    const res = await app.request(`/api/file?vault=${vaultId}&path=index.md`, {
      headers: {
        Origin: "http://evil.example",
        "X-Forwarded-Host": "localhost:3010",
      },
    });
    expect(res.status).toBe(200);
  });
});
