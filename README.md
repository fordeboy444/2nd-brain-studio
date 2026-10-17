# 2nd Brain Studio

A single-user web app: give it a YouTube channel URL or a web page URL, set
filters, and start a job. It downloads the transcripts or scrapes the page, runs a
bounded number of plain LLM calls over them, and writes a browsable Open Knowledge
Format bundle — markdown files with YAML frontmatter, cross-linked by relative
links, every claim citing the exact video timestamp or the source page.

It keeps the visual design of the reference desktop app (`baalda/`) and produces
the same bundle format as the reference `cole-medin-knowledge-base/`, but with a
fixed pipeline instead of a sub-agent swarm, and it ships as one web container that
deploys on Coolify.

## Run it locally

```bash
pnpm install
pnpm dev
```

- `pnpm dev` starts the server and the SPA dev server. The API listens on port
  **3010**; the Vite dev server for the SPA listens on port **5173**. Open
  <http://localhost:5173> — `/api` is proxied to 3010, so the SPA and the API stay
  same-origin in development and in production.
- No Docker is needed for local work; the app runs directly on Node 22. The image
  is built on the deploy host.
- Ollama credentials are read from the environment, and an empty value counts as
  unset: without a key the app still serves and `GET /api/health` answers with
  `"status": "degraded"`.

## Test and build

```bash
pnpm test           # the deployment spec: the Dockerfile and the compose file
pnpm -r test        # every package's unit and integration suites
pnpm run test:all   # both
pnpm -r build       # build both packages (development does not need this)
```

## Deploy

One container, one volume, one compose file. Deploy
`deploy/coolify/docker-compose.yml` as a Docker Compose resource on Coolify. The
runbook — the fields to enter, the variables and their defaults, and the four
Coolify behaviours that bite this stack — is
[`deploy/coolify/README.md`](deploy/coolify/README.md).

## Where things stand

The vault model and the browse shell work end to end. Transcript ingest, the
generation stages and export land in later phases. The specification is `idea.md`;
the phase plans and research live in `.planning/`.
