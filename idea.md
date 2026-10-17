# 2nd Brain Studio — idea

## Context 📌

**The problem.** Two reference projects sit side by side. Neither is the target product.

- `baalda/` — a local-first desktop app (Tauri + Rust + React 19 + Postgres + Yjs). Good UI. But it is a desktop shell, and its CRDT stack is not needed here.
- `cole-medin-knowledge-base/` — an Open Knowledge Format (OKF) bundle. Plain markdown, YAML frontmatter, navigation by `index.md` and relative links. Good output format. But ~700 Claude Code sub-agent runs build it. It is slow, token-heavy, and a non-expert cannot operate it.

**The goal.** One web app. Type a YouTube channel URL or a web page URL. Set filters. Get a browsable OKF knowledge graph. The app keeps the Baalda look. It deploys on Coolify. The build pipeline is deterministic code plus a bounded number of plain LLM calls — not sub-agent swarms.

**Decisions already taken:**

| Decision | Choice |
|---|---|
| Form | One web app, one container. **Not** the Tauri desktop app. |
| Scope | **Single user.** No login, no auth, no database. Markdown files are the only truth. |
| Location | Repo root `/home/orca/Projects/2ND Brain/`. The two reference repos stay untouched and read-only. |
| UI | Copy Baalda's design system and its pure TS libraries. Rebuild the panels that talk to Tauri. |
| LLM | **Ollama Cloud.** One model for all stages. Default `beam:cloud`. Changeable in Settings. |
| Transcripts | 1️⃣ yt-dlp → 2️⃣ free `youtube-transcript-api` (jdepoix) → 3️⃣ Supadata (only if a key is set) |
| Name | **2nd Brain Studio** |
| OKF version | Root `index.md` declares `okf_version: "0.1"` — same as the reference bundle |
| Quality sweeps | Gap-fill, recall and notability triage stay, **behind a switch that is off by default** |

**Outcome.** Open a URL in a browser, start a job, watch live progress, then read a cross-linked graph. Every claim cites the exact video timestamp or the source page.

---

## Architecture 🏗️

```
                    Coolify host — Traefik terminates TLS
                                │
              ┌─────────────────▼──────────────────────┐
              │  container "app"   (expose 3010)        │
              │                                         │
 Browser ────▶│  Node 22 / Hono                         │
 (React SPA)  │    /api/*   JSON + SSE                  │
      │       │    /*       static SPA                 │
      │       │                                         │
      └──SSE─▶│  Job runner (in-process)                │
              │    stage graph · semaphore · lock file  │
              └───┬──────────┬──────────┬───────────────┘
                  │          │          │
                  ▼          ▼          ▼
             yt-dlp /    Ollama      Readability
             py API /    Cloud       + jsdom
             Supadata    /v1/chat    + turndown
                  │          │          │
                  └──────────┴──────────┘
                             │
                    volume  okf_vaults : /data/vaults
                             │
        ┌────────────────────┴─────────────────────┐
        │  vaults.json    registry                  │
        │  settings.json  app settings              │
        │  <vault-id>/    an OKF bundle             │
        │     index.md SCHEMA.md log.md             │
        │     concepts/ entities/ sources/ raw/     │
        │     .okf/   jobs, caches, settings        │
        └───────────────────────────────────────────┘
```

**One process, one container, one volume.** The job runner lives in-process. That is correct for one user, and it keeps the container count at 1.

**Why these pieces:**

- **Hono 4 + `@hono/node-server`** — the same framework as `baalda/app/apps/server`. `streamSSE()` is built in, so job progress needs no extra library.
- **The same Node process serves the built SPA.** One port, no CORS, no second service. Vite proxies `/api` to `:3010` in development.
- **SSE, not polling, for job progress.** Progress is one-way and bursty. `EventSource` gives reconnect and `Last-Event-ID` for free — and that is exactly how a job survives a container restart. Polling stays only for the job list, where 2 s is fine.
- **No database.** State is JSON plus the markdown itself. No migrations, no schema drift. A vault folder is portable; you can copy it out and drop it beside any project.
- **Python lives in the image.** `yt-dlp` and `youtube-transcript-api` are Python. The container installs both. Node calls them as subprocesses and never reimplements them.

---

## Repo layout 📁

```
2ND Brain/
├── baalda/                       ← reference, untouched
├── cole-medin-knowledge-base/    ← reference, untouched
├── package.json  pnpm-workspace.yaml  tsconfig.base.json
├── Dockerfile                    single image: builds web + server, runs server
├── deploy/coolify/docker-compose.yml  +  README.md
├── templates/okf-bundle/         seed bundle copied into every NEW vault
│   └── SCHEMA.md  README.md  log.md  index.md
├── packages/okf/                 PURE TypeScript OKF library — no I/O, no deps
│   └── src/{frontmatter,links,indexes,lint,slug,time,types}.ts
├── apps/server/src/
│   ├── index.ts                  boot: config → registry → lock → resume jobs → listen
│   ├── http/{app,sse}.ts  http/routes/{vaults,files,tree,search,graph,jobs,settings,lint}.ts
│   ├── vault/{registry,fs,tree,scaffold}.ts
│   ├── jobs/{store,runner,pool}.ts  jobs/stages/{enumerate,fetch,extract,canonicalize,pages,sweep,finalize}.ts
│   ├── youtube/{ytdlp,pytapi,supadata,fetch}.ts    the 3-tier cascade
│   ├── web/{scrape,extract}.ts
│   └── llm/{client,prompts,json,cache}.ts
├── apps/web/src/
│   ├── styles/{tokens.css,App.css}  assets/fonts/*  lib/{theme,api,sse,useGraphData}.ts
│   ├── components/…   screens/{Browse,Graph,Search,Settings,Jobs,Index}.tsx
└── tests/{fixtures,oracle}/
```

---

## The pipeline ⚙️ — the core of the idea

Seven stages. **Four are deterministic. Three call the LLM.** Every stage writes its artifact to disk before the next one starts. So the pipeline resumes at stage granularity and repeats safely at unit granularity.

```
S0 enumerate ─▶ S1 fetch ─▶ S2 extract ─▶ S3 canonicalize ─▶ S4 pages ─▶ S5 finalize ─▶ (S6 sweep)
deterministic   deterministic  LLM 1/video   LLM batched        LLM prose   deterministic    optional
                                    │        (the barrier)      + code assembly
                                    └─ web branch: S1w scrape ─▶ same S2…S5
```

| # | Stage | Kind | Output | LLM calls @ 200 videos |
|---|---|---|---|---|
| S0 | **Enumerate** | code | `01-enumerate.json` — the candidate list | 0 |
| S1 | **Fetch transcripts** | code | `raw/<slug>.md`, immutable | 0 |
| S1w | **Scrape web page** | code | `raw/<slug>.md`, `type: raw-capture` | 0 |
| S2 | **Extract** | LLM, **1 per video** | `extractions/<slug>.json` | 200 |
| S3 | **Canonicalize** | LLM, **batched, barrier** | `manifest.json` + `taxonomy.json` | 6 |
| S4a | **Source pages** | **code** | `sources/<slug>.md` | **0** |
| S4b | **Concept + entity prose** | LLM, 5 pages per call | page bodies; code assembles the rest | 88 |
| S5 | **Finalize** | code | 7 index files, `log.md`, lint report | 0 |
| S6 | **Sweep** (optional) | LLM, batched | gap-fill and triage pages | +~40 |
| | | | **Total** | **≈ 294** (≈ 1.5 per video) |

### How the cost drops — six structural moves

1. **The transcript is read by the LLM exactly once.** Every later stage reads the compact extraction JSON, never the transcript. The reference re-pays the transcript context on every run that touches the video. This is the main reason its cost scales badly.
2. **`thesis` and `summary` come out of the extraction.** So the source page is 100 % code-rendered. That deletes the ~200 calls the reference spends writing source pages.
3. **Page structure is built in code.** Frontmatter, the `## Sources` bullets, and every typed edge (`## Builds on`, `## Part of`, `## Contrasts with`, …) come from the manifest. The LLM writes **only** the 2–4 paragraph body. So a hallucinated link or a dropped citation cannot corrupt the bundle.
4. **Candidates are filtered in code before the LLM sees them.** Exact-slug dedupe and tag union run first. The page-creation threshold (`≥ 2 videos`, or one deep dive) also runs in code. That stops a 785-candidate list from becoming an LLM problem.
5. **Every unit is content-addressed.** Cache key = `sha256(model + PROMPT_VERSION + sha256(input))`. Consequences worth stating plainly:
   - Re-run the same job with the same model and prompt ⇒ **0 LLM calls**.
   - Change the model ⇒ S2–S4 re-run. S0 and S1 stay free. Raw transcripts stay untouched.
   - Edit one prompt ⇒ only that stage re-runs.
   - Add videos to an existing vault ⇒ only the new work costs.
6. **The sweep is optional and off by default.** It is the only stage that is "nice to have".

**Cost estimate.** ⚠️ These numbers derive from the documented reference scale (925k words over 198 videos) plus stated per-call assumptions. The first real run replaces them.

| Stage | Input tokens | Output tokens |
|---|---|---|
| S2 ×200 | 1.50 M | 0.32 M |
| S3 ×6 | 0.07 M | 0.03 M |
| S4b ×88 | 0.81 M | 0.15 M |
| **Total** | **2.38 M** | **0.50 M ≈ 2.9 M tokens** |

**Against the reference:** ~294 calls vs ~700 agent runs. **≈ 2.4× fewer calls, ≈ 6–10× fewer tokens.**

**Wall clock** — worth showing in the UI before a job starts:

| | concurrency 1 (Free) | concurrency 3 (Pro) |
|---|---|---|
| S0 + S1 (200 videos) | ~7 min | ~7 min |
| S2 + S3 + S4 | ~2 h 5 min | ~45 min |
| **Total** | **≈ 2 h 15 min** | **≈ 55 min** |

This is a **background job, not a request**. Start it, close the tab, come back. That is why SSE plus disk-persisted job state are required, not optional.

### Transcript cascade

```
video id ─▶ 1. yt-dlp --write-auto-subs --sub-format json3   ✅ preferred
              (also prints metadata: title, upload_date, duration)
              └─ no captions / blocked?
                 ─▶ 2. python3 -I -m youtube_transcript_api  (free, jdepoix)
                      └─ still nothing?
                         ─▶ 3. Supadata, only if the key is set
```

💡 **Metadata is separate from the transcript.** yt-dlp's flat-playlist call already gives `upload_date` and `duration` for every video, and it usually works even when subtitles do not. So `published` and `duration` come from S0, not from the cascade. The cascade is about the transcript text only.

Every fetch writes `raw/<slug>.md` as an immutable capture. If the file exists and its `youtube_id` matches, the stage skips it with no network call. A failed video goes to `skipped[]` with a reason and **never** aborts the job.

### LLM reliability — `llm/json.ts` ⚠️

Ollama Cloud has **no JSON-schema structured output**. Malformed output at 294 calls is a certainty. So this module is a first-class, unit-tested part of the design — not a try/catch.

```ts
extractJson(text)   // strip ```json fences, scan for the first balanced {...},
                    // honour strings and escapes, drop trailing prose
repairJson(js)      // close unbalanced braces, drop trailing commas,
                    // normalise curly quotes and dashes, strip comments
parseWith<T>(text, validate)
callJson<T>(client, messages, validate, { attempts: 3 })
```

The retry ladder: **1)** the raw call. **2)** the same messages plus `"Your previous output was not valid: <errors>. Return ONLY the corrected JSON."` **3)** the same, with the bad output echoed back and truncated. Then fail that unit and record it.

The validators also **normalise**: force `subtype` into the enum, kebab-case every slug, truncate quotes to 240 chars, drop a quote whose timestamp does not parse. One bad video never fails the job. Its source page still exists, marked `partial: true`.

Every raw reply is saved under `.okf/jobs/<id>/llm/` for debugging.

### Concurrency, resume and the lock 🔒

```ts
const llmPool   = new Semaphore(settings.llm.concurrency);   // 1 (Free) | 3 (Pro)
const fetchPool = new Semaphore(settings.fetch.concurrency); // 2, independent
```

- **S2 and S4b** fan out through `llmPool`. **S3 is a barrier.** **S0/S1/S5** are local I/O.
- The pool size is a **setting**, so the same code is correct on Free (1) and Pro (3).
- Retry on 429/5xx with backoff. A 429 is the expected failure at concurrency 1.
- **Boot:** scan `jobs/*/job.json` for `queued` or `running`, and re-enqueue. Safe, because every unit is idempotent. A stage advances `job.json.stage` only after its artifact is fully written (tmp + rename).
- **Client reconnect:** SSE replays `events.ndjson` for `seq > Last-Event-ID`.
- **`.lock` file** with a PID and a heartbeat. A second container instance refuses to run jobs and serves read-only. This is what makes in-process job state safe on Coolify.

---

## Data model on disk 💾

**`vaults.json`** — the registry. Paths stay relative, so the volume is portable.

```jsonc
{ "version": 1,
  "vaults": [{
    "id": "cole-medin", "name": "Cole Medin — AI Knowledge Base", "path": "cole-medin",
    "sourceKind": "youtube", "sourceUrl": "https://www.youtube.com/@ColeMedin",
    "createdAt": "…", "lastOpenedAt": "…",
    "stats": { "concepts": 190, "entities": 250, "sources": 200, "raw": 200, "words": 925000 }
  }]}
```

**`settings.json`** — app settings. A per-vault override lives in `$VAULT/.okf/settings.json`. A job snapshots the effective settings into its own record, so a re-run stays reproducible after you change settings.

```jsonc
{ "llm":   { "baseUrl": "https://ollama.com", "model": "beam:cloud",
             "concurrency": 1, "requestTimeoutMs": 180000, "maxRetries": 4 },
  "fetch": { "delayMs": 2000, "concurrency": 2, "language": "en", "supadataApiKey": "" },
  "sweep": { "enabled": false },          // the optional quality sweep
  "ui":    { "theme": "system" } }
```

**`$VAULT/.okf/jobs/<jobId>/job.json`** — the job record. Progress is *derived* from the artifact directories on boot, so a restart never loses the count.

```jsonc
{ "id": "j_20261017_8f3a", "vaultId": "cole-medin", "kind": "youtube",
  "status": "running", "stage": "extract",
  "settings": { /* snapshot */ },
  "input": { "channelUrl": "…", "maxVideos": 200, "dateFrom": "2023-01-01",
             "language": "en", "mode": "add" },
  "progress": { "unitsTotal": 200, "unitsDone": 61, "unitsFailed": 2, "unitsSkipped": 12,
                "llmCallsMade": 61, "llmCallsCached": 12, "tokensIn": 431000, "tokensOut": 92000 },
  "lint": { "errors": 0, "warnings": 7 }, "error": null }
```

**Disk layout inside a vault:**

```
<vault>/                      the OKF bundle — portable, droppable
│  index.md SCHEMA.md README.md log.md
│  concepts/<slug>.md
│  entities/{tools,people,organizations}/<slug>.md
│  sources/<slug>.md
│  raw/<slug>.md  +  raw/manifest.json
└─ .okf/                      PRIVATE — excluded from lint and from the index globs
   ├─ settings.json
   ├─ cache/{search.json,graph.json}
   └─ jobs/<id>/{job.json, events.ndjson, 01-enumerate.json,
                 extractions/<slug>.json, manifest.json, taxonomy.json,
                 pages/<kind>/<slug>.body.json, lint-report.json, done.json}
```

⚠️ **`.okf/` must be pruned** from the lint walk and from `buildIndexes()`. The reference bundle has no such directory, so this is our first lint adaptation. Without it, every job record becomes an E1 error.

**Path safety.** Every request path is jailed: `path.resolve`, then `startsWith(vaultDir)`, then a `realpath` re-check to defeat symlinks. Reject `..`, absolute paths and null bytes before resolution. This mirrors `baalda/app/apps/desktop/src-tauri/src/vault.rs`.

---

## OKF profile 📄

Hard rules honoured exactly: a non-empty `type` on every page; `index.md` and `log.md` reserved; cross-links are relative markdown links, **never** wikilinks; consumers tolerate broken links.

**Decision: keep `type: source` for both kinds, and add a `source_kind` discriminator.** The reference bundle's indexes, lint and consumers all key off `type: source`. A second source type would fork every rule we want to reuse. `source_kind` defaults to `video`, so an existing bundle stays valid.

**Video source page** — unchanged from the reference:

```yaml
---
type: source
source_kind: video            # NEW. optional, default "video"
title: "…"  description: "…"  # description = extraction.thesis
youtube_id: 60G93MXT4DI
url: https://www.youtube.com/watch?v=60G93MXT4DI
slug: why-ai-coding-abandoned-rag
published: 2026-05-14
duration: "14:52"
recency_rank: 19
raw: "../raw/why-ai-coding-abandoned-rag.md"
tags: [rag, retrieval]  created: …  updated: …
---
```

**Web source page** — page-native fields replace the video ones:

```yaml
---
type: source
source_kind: web
title: "Attention Is All You Need"  description: "…"
url: https://arxiv.org/abs/1706.03762
site: arxiv.org                       # hostname, for grouping and display
author: "Vaswani et al."              # when extractable, else ""
published: 2017-06-12                 # when extractable, else ""
fetched_at: 2026-10-17                # always — when WE captured it
slug: attention-is-all-you-need
raw: "../raw/attention-is-all-you-need.md"
tags: [transformers, attention]  created: …  updated: …
---
```

Body sections match a video source page, except `## Extracted text` replaces `## Transcript`.

**Raw pages — two types, one parity rule:**

| | video | web |
|---|---|---|
| `type` | `raw-transcript` | **`raw-capture`** |
| extra frontmatter | `youtube_id`, `duration`, `fetched_at`, `immutable: true` | `url`, `site`, `captured_at`, `immutable: true`, `capture_kind: page` |
| body | `## Transcript`, paragraphs prefixed `**[H:MM:SS]** text` | `## Extracted text`, paragraphs prefixed `**[#n]** text` |

💡 The `**[#n]**` anchor is the web analogue of a timestamp. It gives the citation checker somewhere to look, and it keeps the raw page a deterministic capture. Video raw pages stay byte-compatible with the reference.

**The `## Sources` bullet grammar.** The reference shape is:

```markdown
- [Video Title](../sources/<slug>.md) - "[H:MM:SS] verbatim quote"
```

We keep the link + ` - ` + quoted-text skeleton for both kinds, and relax the timestamp **only** for web sources:

```markdown
- [Attention Is All You Need](../sources/attention-is-all-you-need.md) - "verbatim sentence"
```

**One naming deviation.** The reference marks provenance on concept and entity pages with `videos: [...]`. That name is wrong for a web contribution. Our generator writes **`sources: [...]`**, and the lint **accepts either key**. An imported reference bundle therefore still passes.

### Lint adaptations — `packages/okf/src/lint.ts`

| Rule | Reference | Ours |
|---|---|---|
| **E1** non-empty `type` | unchanged | unchanged — but the walk **prunes `.okf/`** |
| **E2** every relative link resolves | unchanged | unchanged (strips fenced and inline code; skips http/mailto/#) |
| **E3** index coverage | concepts and entities must appear in some `index.md` | **unchanged, and free** — web sources land in the same `sources/` directory, and `sources_index()` globs `*.md` with no type awareness |
| **E4** sources ↔ raw parity | ERROR if a source has no raw page; WARNING the reverse | **unchanged** — parity is by stem only, so `raw-capture` partners satisfy it automatically |
| **W1** orphan concepts and entities | unchanged | unchanged |
| **E5** schema honesty (new) | — | **ERROR** if `source_kind: web` carries a `youtube_id`, or `source_kind: video` lacks one |
| **E6** web citation (new) | — | **WARNING** if a `## Sources` bullet for a web source carries an `[H:MM:SS]` timestamp |
| **E7** no wikilinks (new) | prose only | **ERROR** on any `[[wikilink]]` — the OKF spec forbids them |
| citation integrity | the quote must appear in the cited transcript within `[ts-45, ts+120]`, ≥ 55 % word overlap | unchanged for video. For web, whole-document overlap at the same 55 % threshold |

**Root index banner.** The reference hand-maintains it. We auto-generate the coverage banner between `<!-- GENERATED:BANNER -->` markers, and the banner counts sources **by kind** (`200 videos, 12 web pages`). This is our one deliberate deviation on the root index, so the root index is excluded from the byte-identical oracle test.

---

## API surface 🔌

All under `/api`. Errors are uniform: `{ "error": { "code", "message", "detail" } }`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | `{ok, version, uptimeSec, jobs:{running,queued}}` — also the compose healthcheck |
| `GET` `PUT` | `/api/settings` | effective settings. The Supadata key is **redacted** to `hasSupadataKey: bool` |
| `POST` | `/api/settings/test-llm` | one tiny call against the configured model |
| `GET` `POST` | `/api/vaults` | list; `POST {name, mode:"new"\|"existing", path?}` scaffolds from `templates/okf-bundle` |
| `GET` `DELETE` | `/api/vaults/:id` | detail + stats; `?purge=true` also deletes the directory |
| `GET` | `/api/vaults/:id/tree` | `?dir=` — lazy, one directory at a time |
| `GET` `PUT` `POST` `DELETE` | `/api/vaults/:id/file` | read, write, create, delete. `PUT` takes `baseHash` and returns **409** on conflict |
| `GET` | `/api/vaults/:id/search` | `?q=&type=&limit=` — server-side scan, no embeddings |
| `GET` | `/api/vaults/:id/graph` | `{nodes:[{id,title,type,subtype}], edges:[{source,target,kind}]}` |
| `GET` | `/api/vaults/:id/backlinks` | `?path=` — each hit carries the heading it sits under |
| `GET` | `/api/vaults/:id/frontmatter-index` | powers type-filtered browse and search facets |
| `POST` | `/api/vaults/:id/lint` · `/reindex` | run lint live; regenerate indexes with no LLM |
| `POST` `GET` | `/api/jobs` | create a job; list with `?vaultId=&status=` (poll target) |
| `GET` `DELETE` | `/api/jobs/:id` | record; abort in flight |
| `POST` | `/api/jobs/:id/retry` | `{onlyFailed:true}` re-enqueues only the failed units |
| **`GET`** | **`/api/jobs/:id/events`** | **`text/event-stream`** — frames `progress`/`unit`/`stage`/`error`/`done`, each with `id: <seq>`. `:keepalive` every 15 s. Headers `X-Accel-Buffering: no`, `Cache-Control: no-cache` |
| `GET` | `/api/jobs/:id/artifacts` | `?kind=extraction&slug=` — lets the UI show the extraction behind a page |

⚠️ The `file` endpoint is the only one that touches disk. It goes through `vault/fs.ts`, which jails every path.

---

## UI 🎨

### Copy from `baalda/app/apps/desktop/src` — no Tauri, no Yjs

| File | Note |
|---|---|
| `styles/tokens.css` | untouched — the whole design system |
| `assets/fonts/fonts.css` + 6 × `OpenSauceTwo-*.woff2` | untouched, offline |
| `App.css` | **copy, then prune.** Strip the account, sync, billing, member and health rulesets. Keep the shell, sidebar, editor, panel, dialog, toast and graph rules. Do this in Phase 2, not at the end |
| `lib/theme.ts`, `components/ThemeToggle.tsx` | untouched |
| `components/Toasts.tsx` + `lib/toast.ts` | untouched |
| `ConfirmDialog.tsx`, `AsyncButton.tsx`, `Switch.tsx`, `MenuSelect.tsx`, `Banner.tsx`, `InlineTitle.tsx`, `Spinner.tsx` | untouched |
| `TabBar.tsx`, `RightPanel.tsx`, `SidebarHeader.tsx`, `BacklinksPanel.tsx`, `rightPanelTab.ts`, `useNoticeSlot.ts` | near-untouched; swap the data source to the store and the API |
| `lib/graph/{simulation,graphColor,graphSettings,webglRenderer}.ts`, `components/GraphControls.tsx`, `graph.css` | untouched — the physics and the renderer have no Tauri coupling |
| `components/GraphView.tsx` | structure copied; the data hook swaps to `GET /api/graph` |

### Rebuild — these touch Tauri or Yjs

| New file | Replaces | Why |
|---|---|---|
| `components/VaultTree.tsx` | `FileTree.tsx` (2880 lines) | imports `@tauri-apps/*` for drag-drop. Rebuild on `GET /api/tree` with `react-arborist` |
| `components/MarkdownEditor.tsx` | `Editor.tsx` (1004 lines) | Yjs + `convertFileSrc`. Rebuild: plain CodeMirror 6, save with `PUT`, conflict banner from `Banner.tsx` |
| `components/MarkdownView.tsx` | `FilePreview.tsx` / `HtmlView.tsx` | `marked`, read-only, with **relative `.md` link rewriting** into app navigation. This is what makes index pages navigable. A broken link renders as a tolerated span |
| `screens/SearchScreen.tsx` | `SearchPanel.tsx` | Baalda searches in memory; ours calls `GET /api/search` |
| `App.tsx` shell | `App.tsx` (1839 lines) | keep the panel model; drop auth, sync and updater |
| `lib/{api,sse,useGraphData}.ts` | `lib/ipc.ts` | the boundary becomes HTTP |
| 🆕 `screens/SettingsScreen.tsx` | — | **requirement 1** |
| 🆕 `screens/JobsScreen.tsx` + `JobProgressScreen.tsx` | — | job list (2 s poll) + live progress (SSE) |
| 🆕 `screens/IndexScreen.tsx` | — | renders an OKF `index.md` as the navigable catalog |

**Navigation:** no router. One panel model in the Zustand store — `sidebar | editor | rightPanel`, plus `activeOverlay: "none" | "settings" | "graph" | "search" | "jobs"`. Exactly Baalda's model.

### Screens

1. **Browse** — tree (left) · editor (centre, tabs) · right panel with **Backlinks | Outline | Frontmatter | Lint**.
2. **Graph** — the copied `GraphView`. One OKF upgrade: nodes are coloured **by `type`**, and every edge carries the **typed-edge kind** — the heading the link sits under. So you can filter to only `## Builds on` edges. Baalda's graph is untyped; ours gets the semantics free from `packages/okf/src/links.ts`.
3. **Search** — results grouped by type, click opens the page at the line.
4. **Settings** — the ingest form, the LLM block, the fetch block, a Test connection button.
5. **Jobs** — stage stepper, live per-unit feed, a failed-unit table with reasons, Retry-failed and Lint actions.
6. **Index reader** — the OKF catalog, clickable into the bundle.

### The Settings page — requirements 1 and 2

```
┌─ Ingest ─────────────────────────────────────────────────┐
│  Source                                                  │
│   (•) YouTube channel   [ youtube.com/@handle      ]     │
│   ( ) Web page          [ https://blog/post        ]     │
│                                                          │
│  Filters                                                 │
│   Max videos [ 50 ]   From [2024-01-01] To [        ]    │
│   Min duration [ 3:00 ]   Language [ en ]                │
│                                                          │
│   [ Preview ]   →   "412 videos found · 187 match"       │
│                                                          │
│  Destination                                             │
│   ( ) New vault        [ Name                      ]     │
│   (•) Existing vault   [ ▾ Choose a vault          ]     │
│                                                          │
│   [ Start ingest ]   est. ~190 LLM calls · ~25 min       │
└──────────────────────────────────────────────────────────┘
│ Model [ beam:cloud ]  Base URL [https://ollama.com]      │
│ Concurrency [ 1 ▾ ]   Fetch delay [2000 ms]  Lang [en]   │
│ Deep quality sweep (gap-fill + triage)  [ off ]          │
│ Ollama key [•••• set]   Supadata [not set]               │
│ Cookie file for the YouTube bot check  [ Upload ]        │
└──────────────────────────────────────────────────────────┘
```

💡 **Preview is a dry run.** It calls yt-dlp's flat playlist, applies the filters, and writes nothing. It returns `{total, selected, skipped[]}`. So you see the real cost before you commit.

---

## Deploy on Coolify 🚀

One compose file, one service, one volume — modelled on `baalda/deploy/coolify/docker-compose.yml`, which is tested end to end.

```yaml
name: 2nd-brain-studio
services:
  app:
    build: { context: ., dockerfile: Dockerfile }   # Coolify's project dir IS the repo root
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "3010"
      VAULT_ROOT: /data/vaults
      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-https://ollama.com}
      OLLAMA_MODEL: ${OLLAMA_MODEL:-beam:cloud}
      OLLAMA_API_KEY: ${OLLAMA_API_KEY:-}
      SUPADATA_API_KEY: ${SUPADATA_API_KEY:-}
      SERVICE_FQDN_APP:            # Coolify magic var -> assigns the domain
    expose: ["3010"]               # NO ports: — Traefik reaches the container internally
    volumes: ["okf_vaults:/data/vaults"]
    healthcheck:
      test: ["CMD","node","-e","fetch('http://127.0.0.1:3010/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
volumes: { okf_vaults: {} }
```

**Four Coolify lessons we bake in on day one** — from `baalda/deploy/coolify/README.md`:

1. `build.context: .` — Coolify runs compose with the repo root as the project dir.
2. `expose`, never `ports:` — Traefik terminates TLS.
3. ⚠️ **`${VAR:?message}` means "prefilled default" in Coolify, not "error".** Use `${VAR:-default}`.
4. ⚠️ **An unset `${VAR}` interpolates to an empty string, not an absent key.** So `config.ts` must treat `""` as unset. An empty `OLLAMA_API_KEY` must mean "not configured" — the Settings page shows a clear message, and a job refuses to start. It must not crash the process on boot. This exact bug crashed both services in Baalda.

**Dockerfile** — multi-stage, `node:22-bookworm-slim` (not alpine; the Python toolchain is easier on glibc):

```dockerfile
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/  … packages/okf/package.json packages/okf/
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter web build && pnpm --filter server build
RUN pnpm --filter server --prod deploy --legacy /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=768
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp youtube-transcript-api \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/web/dist ./public     # the SPA
COPY --from=build /repo/templates ./templates      # the OKF seed bundle
EXPOSE 3010
VOLUME ["/data/vaults"]
CMD ["node", "dist/index.js"]
```

💡 `yt-dlp` breaks when YouTube changes. It is a build-time install here, so the README documents "redeploy to refresh yt-dlp". That is the number one operational failure mode for this app.

---

## Build order 📅 — a runnable milestone at every phase

| Phase | Deliverable | Milestone to verify |
|---|---|---|
| **0 — Skeleton + deploy** | workspace, server with `/api/health`, Vite shell with the copied tokens and fonts, Dockerfile, compose | A themed empty shell on a Coolify domain with a real cert. `curl /api/health` → `{ok:true}`. Theme toggle persists |
| **1 — Vault model + browse** | registry, fs jail, tree, scaffold; the vault, tree and file endpoints; VaultTree, MarkdownEditor, MarkdownView | Create a vault, open the scaffold, edit `SCHEMA.md`, save. A stale `baseHash` returns 409. The path jail rejects `../` and symlinks |
| **2 — OKF library + oracle** | all of `packages/okf`; lint, indices and frontmatter endpoints; prune `App.css` | **Oracle test green** — the TS output is byte-identical to the Python on the fixture bundle |
| **3 — Deterministic ingestion** | S0 enumerate, S1 the 3-tier cascade, S1w web scrape, jobs store + runner (no LLM), JobsScreen, SSE | Ingest a **5-video** channel → 5 raw pages + a manifest, with live progress. Kill the container mid-fetch; restart; the job resumes with no duplicate raw files and SSE replays |
| **4 — LLM stages** | llm client, json, cache; S2, S3, S4, S5; S6 behind the switch | **5-video channel → a full OKF bundle that lints clean**, browsable with graph and backlinks. The adversarial JSON suite is green. A re-run makes **0 LLM calls** |
| **5 — Browse features** | search + cache, typed-edge graph, backlinks panel, IndexScreen, frontmatter panel, lint panel | Edge `kind` filtering works. Search is under 100 ms on the fixture. Broken links render as tolerated |
| **6 — Scale + harden** | full CSS prune, retry-failed-units, abort, token counters, README | **200-video channel end to end on Coolify.** Measured tokens within 2× of the estimate, and recorded in the README |

**The ordering is deliberate.** Phase 2 comes before Phase 3, so the deterministic OKF library is proven against the Python oracle before any LLM output depends on it. Phase 3 comes before Phase 4, so the resumability story is proven on cheap, fast stages before the expensive ones sit on top.

---

## Verification ✅

**Unit tests** (`vitest`), and every stage takes an injected `LlmClient`, so tests use recorded responses and never touch the network.

- **`llm/json.test.ts` — the highest-value suite.** Adversarial fixtures, one file each: fenced JSON, trailing prose, a leading apology, smart quotes, a trailing comma, a truncated object, an unescaped newline, two objects, single quotes, a `NaN` literal — plus a valid control. Assert that `callJson` recovers on attempts 1–3 and fails cleanly on the unrecoverable pair. Then assert the validators normalise: `"Tool"` → `tool`, `"The PIV Loop"` → `the-piv-loop`, an unparseable timestamp drops the quote.
- **`stages/extract.test.ts`** — the cache key is stable across runs, and a changed `PROMPT_VERSION` busts it.
- **`stages/canonicalize.test.ts`** — the deterministic dedupe runs **before** the LLM (assert on the first prompt length). The threshold keeps `the-piv-loop` at 2 videos and drops a one-off tool.
- **`stages/pages.test.ts`** — **the key guarantee:** a page whose LLM prose omits every link still ends up with a full, correct `## Sources` section and correct typed edges. Every bullet matches the reference regex.
- **`jobs/runner.test.ts`** — a full 4-transcript job with a fake LLM lints clean. Re-run ⇒ 0 LLM calls. Throw inside S4 ⇒ resume completes with a byte-identical bundle.
- **`jobs/store.test.ts`** — SSE replay: append events 1–50, request with `Last-Event-ID: 30`, assert frames 31–50 arrive in order.
- **`vault/fs.test.ts`** — the path jail: `..`, absolute paths, a symlink escape, `%2e%2e`, null bytes.

**The oracle test — the gate that makes the OKF port trustworthy.** `tests/oracle/run-python-oracle.ts`:

1. Copy `tests/fixtures/bundle-mini/` (3 concepts, 2 tools, 1 person, 1 org, 3 sources, 3 raw pages, and a `taxonomy.json` that covers *some* slugs so the `## Other` bucket is exercised) into two temp directories.
2. Run the **unmodified upstream Python** against copy A. `build_indexes.py` and `lint.py` resolve `ROOT` from `__file__`, so invoke `python3 -I` with a `-c` preamble that rewrites `ROOT` to the fixture directory. **No file in either repo is modified.**
3. Run `buildIndexes()` / `lintBundle()` against copy B.
4. Assert the index files are **byte-identical**, and that the lint error and warning sets are identical after normalising the root prefix — same exit code.
5. `describe.skipIf(!pythonAvailable)` — skip loudly, never pass vacuously.

**Golden test.** Build a 3-video vault with the fake LLM, snapshot the bundle, and assert lint passes clean.

**Network and paid calls stay out of the default `pnpm test`.** A separate opt-in integration test (`RUN_LLM_TESTS=1`) hits `beam:cloud` once with a 200-word transcript to catch model drift.

**Manual end to end.** `pnpm dev` → import `cole-medin-knowledge-base` → browse, search and open the graph over 690 real pages → start an ingest job for `@3blue1brown` with a limit of 3 → watch the SSE progress → open the new vault → confirm a citation opens a real timestamp → run lint from the UI.

---

## Risks ⚠️

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Ollama Cloud has no JSON schema.** Malformed output is certain at 294 calls. | `llm/json.ts` is a shipped, tested module. A per-unit failure is non-fatal, and the page assembly is deterministic, so the bundle stays structurally valid even when prose generation fails |
| R2 | **Concurrency 1 on the Free tier** makes a 200-video run ~2 h 15 min. | The UI shows the estimate before the job starts. Job state is on disk, so you close the tab. Concurrency is a setting |
| R3 | **yt-dlp breaks against YouTube changes.** The most likely failure. | Two fallbacks. The README documents "redeploy to refresh yt-dlp". `skipped[]` shows *why* a video was missed, so you can retry just those |
| R4 | **A YouTube bot check from a datacenter IP.** | A cookie file upload in Settings, then the two fallbacks. Document it — this is the likely first failure |
| R5 | **SSE buffering through Traefik** can freeze the progress view. | `X-Accel-Buffering: no`, `Cache-Control: no-cache`, a 15 s keepalive, and a polling fallback on `GET /api/jobs/:id` if the stream errors twice |
| R6 | **`beam:cloud` quality for canonicalize** is the highest-leverage unknown. A bad merge poisons the bundle. | S3 is cheap (~6 calls, ~100 k tokens) and fully re-runnable from cached extractions. The prompt gets only the label space, so it stays a classification task |
| R7 | **Web pages scrape poorly** — paywalls, JS-only, cookie walls. | Readability handles the common cases. Under 200 words, the job warns and you can paste the text into `raw/<slug>.md` by hand. The file is the truth, so a manual raw page is a first-class input |
| R8 | **A second container doubles the jobs.** | The `.lock` file with a heartbeat. A second instance serves read-only. Documented as "do not scale `app`" |
| R9 | **Pruning 10,851 lines of `App.css`** can cause visual regressions. | Prune by selector-usage grep in Phase 2, with the theme toggle and a shell screenshot as the check. Budget it as real work |
| R10 | **Cost estimate fidelity.** | `job.json.progress` records real calls and tokens. Phase 6 requires the measured numbers in the README |
| R11 | **No auth means no isolation.** | Correct for one user on a private domain. Adding a second user later is a real change, not a config flip |

---

## Needed before the deploy 📌

1. **A Git remote for Coolify.** ⚠️ This directory is **not** a git repo. Coolify builds from a repo URL. Action: `git init`, push to GitHub, then in Coolify add the resource → Docker Compose → Base Directory `/` → Compose Location `/deploy/coolify/docker-compose.yml`.
2. **The Ollama API key** as a Coolify environment variable (`OLLAMA_API_KEY`), or paste it into the Settings page after the first deploy.
3. **A domain.** Coolify assigns one through `SERVICE_FQDN_APP`.
4. 💡 **No Docker on this machine.** Local work runs with `pnpm dev` (Vite + the Node server). The image builds on the Coolify host.
5. 💡 **The cookie file holds live session secrets.** Settings accepts an upload for the YouTube bot check. The app stores it under `/data/` with mode 600 and never returns it to the browser.
