# Deploying 2nd Brain Studio on Coolify

One container, two volumes, one compose file. Coolify builds the image from a
repository URL and runs `deploy/coolify/docker-compose.yml`.

You need two things this repository does not have: a git remote Coolify can read,
and the Coolify host itself. Everything else is in this directory.

## Resource settings

Create a new resource of type **Docker Compose** and fill in these fields:

| Field | Value |
| --- | --- |
| Source | your git remote, on the branch you pushed |
| **Base Directory** | `/` — the repository root, not `deploy/coolify` |
| Docker Compose Location | `/deploy/coolify/docker-compose.yml` |
| Domain | leave it to Coolify: it generates one, writes it into `SERVICE_FQDN_APP`, and terminates TLS for it |
| Ports | nothing to publish. The compose file `expose`s 3010 to Coolify's proxy |
| Volume | declared in the compose file as `okf_vaults` (vault data) and `okf_state` (secrets); Coolify needs no extra setting |

If the build fails, read the build log for the install step first — a Base
Directory that is not the repository root is the most common cause (see the first
pitfall below).

## Variables

Every variable has a default in the compose file, so a deployment works with none
of them set. `deploy/coolify/.env.example` lists them with placeholders; copy the
names into Coolify's Environment Variables and fill in your own values.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3010` | The port the process listens on inside the container |
| `VAULT_ROOT` | `/data/vaults` | Where vaults live. Must match the volume mount point |
| `OLLAMA_API_KEY` | empty | Ollama Cloud key. Empty means the generation stages are not configured |
| `OLLAMA_BASE_URL` | `https://ollama.com` | Ollama Cloud endpoint |
| `OLLAMA_MODEL` | `llama3.1:8b` | The model the generation stages call |
| `SUPADATA_API_KEY` | empty | Paid fallback for the transcript cascade |
| `SERVICE_FQDN_APP` | empty | Coolify's domain variable. Leave it empty and let Coolify assign the domain |

An empty key is a working deployment: the container serves, `GET /api/health`
answers, and the app reports that it is not configured rather than failing.

## Four behaviours this stack depends on

### 1. The build context has to be the repository root

The image installs the pnpm workspace from the lockfile, so the context must
contain `pnpm-workspace.yaml`, the lockfile and the manifests of `apps/server`,
`apps/web` and `packages/okf`.

**Symptom:** the build fails in the install step with a workspace resolution
error (`@2nd-brain/okf` not found, or no workspace projects matched). Set the
Base Directory back to `/`.

### 2. The container port is exposed, never published

The compose file uses the `expose` key: the port is reachable on the container
network, where Coolify's proxy (Traefik) routes to it. Publishing the port with
`ports:` instead would bind a host port and fight the proxy for it.

**Symptom:** the deploy fails with an address already in use, the proxy cannot
obtain a certificate, or the domain answers 502 while the container itself is
healthy. Remove any `ports:` entry; the proxy reaches the container over `expose`.

### 3. The required-variable interpolation form must not be used

Coolify's UI reads the text after a required-form marker as a value you already
supplied, and prefills the field with it.

**Symptom:** the container starts with the literal message as the value — the key
in the environment literally reads `set me`, and the first LLM call fails with an
authentication error while the Settings screen shows a key you never entered.
Every variable in this compose file uses the defaulted form (`${VAR:-default}`)
instead, which Coolify leaves alone.

### 4. An unset variable becomes an empty string, not a missing variable

An unset variable interpolates to `""`, so a deployment that sets nothing still
*has* `OLLAMA_API_KEY` in its environment.

**Symptom:** an app that only checked whether a variable exists would treat an
unset key as configured and fail on the first job with a 401 from the provider.
That is why the server treats the empty string as unset (`apps/server/src/config.ts`),
why `GET /api/health` answers `"status": "degraded"`, and why no job starts. It is
also why the healthcheck keys on the HTTP status rather than on the JSON body: an
incomplete configuration should be diagnosed from the health route, not from a
container restarting in a loop.

## Operating it

- **The volumes are the only state.** `/data/vaults` (volume `okf_vaults`) holds
  the vault markdown, the registry and the job state. `/data` (volume
  `okf_state`) holds the secret files — the Ollama API key and the YouTube
  cookie. Everything else in the container is disposable, so a redeploy keeps
  the vaults **and** the secrets.
- **Refreshing the Python downloader means a redeploy.** `yt-dlp` is installed at
  image build time and pinned to one release, because YouTube changes break it
  without notice. The image also pins Deno and `yt-dlp-ejs`, because yt-dlp needs
  both to solve YouTube's n challenge. Bump any of the four pins (`yt-dlp`,
  `yt-dlp-ejs`, `deno`, `youtube-transcript-api`) in the `Dockerfile`, commit,
  and redeploy — there is no runtime upgrade path. Local tier-1 runs therefore
  need `deno` on `PATH` too.
- **A redeploy replaces the container and keeps the volume.** It is also the only
  way to pick up a new image.
- **Logs** are Coolify's container log. The app logs method, path and status only
  — never request bodies, headers or secrets.

## The session-secret cookie file

The YouTube bot check can require cookies from a signed-in browser session, and
that file is live session material:

- It lives in the data directory, outside every vault directory — `/data/cookies.txt`.
- Restrict it to the service user with `chmod 600 /data/cookies.txt`. The container
  runs as uid 1001, so the file must be owned by that user.
- It is never returned to the browser: no route reads it, and the vault browser can
  only resolve paths inside `/data/vaults`.
- **Never place a cookie file inside a vault directory.** Vaults are browsable and
  exported, so a cookie file inside one would be listed, opened and copied along
  with the notes. Keep it next to the vaults directory, never within it.
- It is never part of the image either: `.dockerignore` excludes cookie files from
  every build context.

## After the deploy

Open the domain and check, in this order:

1. The app renders with the reference styling and the theme toggle works.
2. A vault can be created through the UI and then appears in the list.
3. `GET /api/health` answers with a JSON status on the same domain.
4. Trigger a redeploy, reload the domain, and confirm the vault is still listed —
   that last check is the one that proves the volume is mounted where the server
   expects it.
