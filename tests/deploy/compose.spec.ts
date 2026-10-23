import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural checks over the deployment artifacts: Dockerfile, .dockerignore,
 * deploy/coolify/docker-compose.yml and deploy/coolify/.env.example.
 *
 * This is a static check. There is no Docker daemon in this environment and no
 * YAML library in the dependency set, so the compose file is read as text rather
 * than parsed, and `docker compose config` is never run. The properties pinned
 * here are the ones a host-side deploy would otherwise be the first to discover:
 * the interpolation form, the absence of a published port, the volume path
 * matching the server's own VAULT_ROOT default, and the healthcheck path
 * matching the route the server actually mounts.
 *
 * The real validation — `docker compose config`, the image build, the deploy —
 * happens on the Coolify host; deploy/coolify/README.md names those steps.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

function readRepoFile(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

const COMPOSE_PATH = "deploy/coolify/docker-compose.yml";
const compose = readRepoFile(COMPOSE_PATH);
const dockerfile = readRepoFile("Dockerfile");
const dockerignore = readRepoFile(".dockerignore");
const envExample = readRepoFile("deploy/coolify/.env.example");
const runbook = readRepoFile("deploy/coolify/README.md");

/** The runtime stage, from its FROM line to the end of the file. */
const runtimeStage = dockerfile.slice(
  dockerfile.lastIndexOf("FROM node:22-bookworm-slim AS runtime"),
);

/** Every `${...}` reference in a document, verbatim. */
function interpolations(text: string): string[] {
  return text.match(/\$\{[^}]*\}/g) ?? [];
}

/**
 * A document with its line comments removed, so prose that explains a rule
 * (the comments in the compose file quote the interpolation forms) cannot be
 * mistaken for the thing the rule is about.
 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf("#");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** The compose file as configuration, ignoring explanatory comments. */
const composeCode = withoutComments(compose);

/**
 * The credential shapes a build or a commit should never carry. The leading word
 * boundaries keep the check quiet about long base64 strings that merely contain
 * the same letters.
 */
const CREDENTIAL_PATTERNS =
  /\bsk-[A-Za-z0-9]{20,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|-----BEGIN [A-Z]+ PRIVATE KEY-----/;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".claude",
  ".gsd",
  ".planning",
  "baalda",
  "cole-medin-knowledge-base",
]);

/** Generated, never authored: its integrity hashes are not secrets. */
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);

const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp4|webm|pdf|zip|gz|wasm)$/i;

/** Every text file this repository authors, as `{file, text}`. */
function readFirstPartyFiles(
  dir: string,
  found: Array<{ file: string; text: string }> = [],
): Array<{ file: string; text: string }> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) readFirstPartyFiles(path, found);
      continue;
    }
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
    if (BINARY_EXTENSIONS.test(entry.name)) continue;
    if (statSync(path).size > 1_000_000) continue;
    found.push({ file: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") });
  }
  return found;
}

/** The names of every `${NAME...}` reference in a document. */
function interpolatedNames(text: string): string[] {
  const names: string[] = [];
  for (const ref of interpolations(text)) {
    const name = /^\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(ref)?.[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The two-space-indented keys directly under a top-level block. */
function topLevelKeys(text: string, block: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `${block}:`);
  if (start === -1) return [];
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) break; // left the block
    const match = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (match !== null) keys.push(match[1]);
  }
  return keys;
}

/** The non-comment KEY=value lines of a dotenv file. */
function dotenvEntries(text: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at === -1) continue;
    entries.push({ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  }
  return entries;
}

describe("the compose file", () => {
  it("declares exactly one service, for the project, built from the repository root", () => {
    expect(topLevelKeys(compose, "services")).toEqual(["app"]);
    expect(compose).toMatch(/^name: 2nd-brain-studio$/m);
    expect(compose).toMatch(/context: \./);
    expect(compose).toMatch(/dockerfile: Dockerfile/);
  });

  it("exposes the application port and publishes nothing", () => {
    // `expose` puts the port on the container's internal network for the proxy.
    // `ports:` would bind a host port and collide with the proxy that should own
    // it — a published port is a deploy failure on Coolify, not a nicety.
    expect(topLevelKeys(compose, "services")).toHaveLength(1);
    expect(compose).toMatch(/^ {4}expose:\n {6}- "\d+"$/m);
    expect(compose).not.toMatch(/^\s*ports:/m);
  });

  it("uses only the defaulted interpolation form, never the required one", () => {
    const refs = interpolations(composeCode);
    expect(refs.length).toBeGreaterThan(0);
    // `${VAR:?text}` is read by Coolify as a value the operator already supplied,
    // so the container starts with the literal message as the value.
    for (const ref of refs) expect(ref).not.toContain(":?");
    for (const ref of refs) expect(ref).toMatch(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}$/);
  });

  it("declares the vault volume at the path the server itself defaults to", () => {
    // apps/server/src/config.ts is the source of truth for VAULT_ROOT; the mount
    // point has to agree with it or the container sees an empty vault list.
    const configSrc = readRepoFile("apps/server/src/config.ts");
    const vaultRootDefault = /VAULT_ROOT[\s\S]*?\?\?\s*"([^"]+)"/.exec(configSrc)?.[1];
    expect(vaultRootDefault).toBeDefined();

    expect(topLevelKeys(compose, "volumes")).toEqual(["okf_vaults", "okf_state"]);
    expect(compose).toContain(`okf_vaults:${vaultRootDefault}`);
    expect(compose).toContain(`VAULT_ROOT: ${vaultRootDefault}`);
    // The secret files (Ollama key, YouTube cookie) default to /data/*, outside
    // the vault sub-mount. Without this mount a redeploy erases them.
    expect(compose).toContain("okf_state:/data");
    expect(compose).not.toContain("okf_state:/data/vaults");
  });

  it("health-checks the route apps/server/src/routes/health.ts is mounted at", () => {
    // apps/server/src/http/app.ts is where the route is mounted; the health
    // module itself must exist for that route to answer.
    expect(existsSync(resolve(REPO_ROOT, "apps/server/src/routes/health.ts"))).toBe(true);
    const appSrc = readRepoFile("apps/server/src/http/app.ts");
    const mountedAt = /app\.route\("(\/api\/health)"/.exec(appSrc)?.[1];
    expect(mountedAt).toBe("/api/health");

    const lines = compose.split("\n");
    const healthcheckAt = lines.findIndex((line) => line === "    healthcheck:");
    expect(healthcheckAt).toBeGreaterThan(-1);
    const healthcheck = lines.slice(healthcheckAt).join("\n");
    expect(healthcheck).toContain(mountedAt as string);
    // A failing command must mark the container unhealthy rather than "started".
    expect(healthcheck).toMatch(/process\.exit\(r\.ok \? 0 : 1\)/);
  });

  it("agrees with the image on the port the app listens on", () => {
    const exposedPort = /^EXPOSE (\d+)$/m.exec(dockerfile)?.[1];
    expect(exposedPort).toBeDefined();
    expect(compose).toContain(`- "${exposedPort}"`);
    expect(compose).toContain(`PORT: "${exposedPort}"`);
    expect(compose).toContain(`127.0.0.1:${exposedPort}`);
  });

  it("declares Coolify's domain variable so a domain is assigned", () => {
    expect(compose).toMatch(/^ {6}SERVICE_FQDN_APP: /m);
  });
});

describe("the Dockerfile", () => {
  it("pins the Python downloader to one release, in a single layer", () => {
    expect(runtimeStage).toContain("python3");
    expect(runtimeStage).toMatch(/yt-dlp==\d{4}\.\d{1,2}\.\d{1,2}/);
    expect(runtimeStage).toMatch(/youtube-transcript-api==\d+\.\d+\.\d+/);
    // One RUN statement: the apt and pip installs share a layer and the apt
    // lists are removed in the same statement that created them.
    expect(runtimeStage).toMatch(/RUN apt-get[\s\S]*?yt-dlp==/);
    expect(runtimeStage).toMatch(/rm -rf \/var\/lib\/apt\/lists/);
  });

  it("runs as a non-root user that owns the data directory", () => {
    const userLine = /^USER (.+)$/m.exec(runtimeStage);
    expect(userLine).not.toBeNull();
    const user = (userLine as RegExpExecArray)[1].trim();
    expect(user).not.toBe("root");
    expect(user).not.toBe("0");
    // The user is created and /data is prepared before the switch, so the
    // process can write vaults without running as root.
    const chownAt = runtimeStage.indexOf("mkdir -p /data/vaults");
    const userAt = runtimeStage.indexOf(`USER ${user}`);
    expect(chownAt).toBeGreaterThanOrEqual(0);
    expect(userAt).toBeGreaterThan(chownAt);
    expect(runtimeStage).toMatch(/\n +&& chown -R [^ ]+ \/data\n/);
    // The mount point exists in the image, so a fresh named volume inherits the
    // service user's ownership instead of root's.
    expect(runtimeStage).toMatch(/VOLUME \["\/data\/vaults"\]/);
  });

  it("installs production dependencies only, from the lockfile", () => {
    expect(runtimeStage).toMatch(/pnpm install --frozen-lockfile --prod/);
    expect(runtimeStage).not.toMatch(/COPY --from=\S+ [^\n]*node_modules/);
  });

  it("starts the entry point the server's start script names, from the repository root", () => {
    const serverPkg = JSON.parse(readRepoFile("apps/server/package.json")) as {
      scripts: Record<string, string>;
    };
    const entry = serverPkg.scripts.start.replace(/^node\s+/, "");
    expect(entry).toBe("dist/index.js");
    // The path keeps the package prefix: the process runs with its working
    // directory at the repository root, which is what the SPA resolution in
    // apps/server/src/http/app.ts depends on.
    expect(runtimeStage).toContain(`CMD ["node", "apps/server/${entry}"]`);
    expect(/^WORKDIR (.+)$/gm.exec(runtimeStage)?.[1]).toBe("/app");
  });

  it("copies the SPA and the vault templates to the paths the server resolves", () => {
    const appSrc = readRepoFile("apps/server/src/http/app.ts");
    const webDist = /resolve\(process\.cwd\(\), "([^"]+)"\)/.exec(appSrc)?.[1];
    expect(webDist).toBe("apps/web/dist");
    expect(runtimeStage).toContain(`COPY --from=web-build /repo/${webDist} ./${webDist}`);
    expect(runtimeStage).toMatch(/COPY --from=\S+ \/repo\/templates \.\/templates/);
  });
});

describe("secret material", () => {
  it("keeps every env variant and the read-only checkouts out of the build context", () => {
    const lines = dockerignore.split("\n").map((line) => line.trim());
    for (const pattern of [".env", ".env.*", "*.env"]) expect(lines).toContain(pattern);
    // The cookie file carries live session secrets and is a run-time file under
    // /data, never build input.
    for (const pattern of ["cookies.txt", "*.cookies", "*cookie*.txt"]) {
      expect(lines).toContain(pattern);
    }
    expect(lines).toContain("baalda/");
    expect(lines).toContain("cole-medin-knowledge-base/");
    expect(lines).toContain(".planning/");
    // Dependencies and build output are produced inside the image, so a stale
    // local copy is never the thing that gets tested or shipped.
    expect(lines).toContain("node_modules");
    expect(lines).toContain("**/dist");
  });

  it("copies no configuration or credential file into any stage", () => {
    expect(dockerfile).not.toMatch(/^COPY[^\n]*(\.env|cookie|\.pem|\.key|id_rsa)/im);
  });

  it("has no credential in a compose value, only an empty default", () => {
    for (const name of ["OLLAMA_API_KEY", "SUPADATA_API_KEY"]) {
      expect(compose).toContain(`${name}: \${${name}:-}`);
    }
    // No interpolation carries a non-empty value that could be a live key.
    for (const ref of interpolations(composeCode)) {
      expect(ref).not.toMatch(/sk-|ghp_|AIza|AKIA|xox[baprs]-/);
    }
  });

  it("ships an env example of placeholders for every variable the compose file sets", () => {
    const entries = dotenvEntries(envExample);
    const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
    expect(byKey.size).toBe(entries.length); // no duplicate keys

    for (const name of interpolatedNames(composeCode)) {
      expect(byKey.has(name), `${name} is missing from .env.example`).toBe(true);
    }

    for (const { key, value } of entries) {
      // A real credential is never committed: keys stay empty, everything else
      // is a URL, a port, a path or a model name.
      expect(value, `${key} looks like a live credential`).not.toMatch(
        /^(sk-|ghp_|AIza|AKIA|xox[baprs]-)/,
      );
      expect(value, `${key} looks like an opaque token`).not.toMatch(
        /^[A-Za-z0-9_\-+/=]{40,}$/,
      );
    }
  });

  it("leaves no plausible credential anywhere in the first-party tree", () => {
    // The deployment reads credentials from the environment, so nothing in the
    // repository needs to carry one. The two reference checkouts and the local
    // planning directory are excluded: they are third-party or local-only
    // content, not artifacts this repository ships.
    const offenders = readFirstPartyFiles(REPO_ROOT).filter(({ text }) =>
      CREDENTIAL_PATTERNS.test(text),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

describe("the runbook", () => {
  it("gives the deployer the resource settings and the variable defaults", () => {
    expect(runbook).toMatch(/Docker Compose/); // the resource type
    expect(runbook).toMatch(/Base Directory/);
    expect(runbook).toContain("/deploy/coolify/docker-compose.yml");
    for (const name of interpolatedNames(composeCode)) {
      expect(runbook, `${name} is missing from the runbook`).toContain(name);
    }
  });

  it("names the session-secret file's location and its restrictive permissions", () => {
    expect(runbook).toMatch(/\/data\/[^\s`]*cookie/i); // outside every vault directory
    expect(runbook).toMatch(/chmod 600/);
    expect(runbook).toMatch(/never returned to the browser/i);
  });

  it("never instructs placing a session-secret file inside a vault directory", () => {
    // A line may only mention a secret file and a vault path together when it is
    // forbidding exactly that: the vault is browsable, so the file would be
    // listed and opened along with the notes.
    const offenders = runbook
      .split("\n")
      .filter((line) => {
        const namesSecretFile = /cookie|session secret|session-secret/i.test(line);
        const namesVaultPath = /vaults?\b/i.test(line);
        const forbids = /\bnever\b|\bnot\b|\boutside\b|\bmust not\b|\bwarning\b/i.test(line);
        return namesSecretFile && namesVaultPath && !forbids;
      })
      .filter(Boolean);
    expect(offenders).toEqual([]);
  });
});
