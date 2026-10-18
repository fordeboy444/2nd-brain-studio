---
type: overview
title: "SCHEMA — How This Knowledge Base Is Built"
description: "The maintainer contract: OKF conformance rules, directory layout, page schemas, linking conventions, and the ingestion workflow for this bundle."
tags: [meta, schema, contract]
updated: 2026-10-17
---

# SCHEMA — How This Knowledge Base Is Built

This file is the **contract** every page in this bundle obeys. It is written for the LLM that maintains the wiki (and any human reviewing it). If you are an agent ingesting a transcript or answering a question, **read this first, then `index.md`.**

This bundle is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) (OKF v0.1) bundle **and** a Karpathy-style [LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): a synthesized, densely cross-linked graph of concepts and entities mined from a source, not raw transcripts. Raw source material is kept immutable under `raw/` for provenance; the knowledge lives in `concepts/`, `entities/`, and `sources/`.

## 1. What this bundle is (and is not)

- **Is:** a synthesized knowledge base covering a source's entire long-form catalog. It is optimized **first for an agent** navigating by index + links, and **second for a human** reading top to bottom.
- **Is not:** a transcript dump, a per-source blog, or a vector database. There is no embedding index; **the compiled wiki IS the search index**. An agent reads `index.md`, follows links, and opens only the atomic pages a question needs.
- **Scope:** long-form sources only. Shorts and livestreams are intentionally out of scope.

## 2. OKF conformance (the hard rules)

Verified against the OKF SPEC (§3.1, §4.1, §5, §9, §11):

1. **Every OKF concept document carries YAML frontmatter with a non-empty `type`.** That is the only strictly required field.
2. **Reserved filenames:** `index.md` (directory listing) and `log.md` (update history). These are the only files that are *not* concept documents and carry no frontmatter, **except** a bundle-root `index.md`, which MAY declare `okf_version`.
3. **A concept's ID is its path within the bundle minus `.md`** (`concepts/the-piv-loop.md` -> `concepts/the-piv-loop`). The path is the identity, so **filenames are stable and never renamed casually.**
4. **Cross-links are ordinary relative markdown links**, never `[[wikilinks]]`. A link asserts an (untyped) directed edge; the *kind* of relationship is carried by the section heading it sits under (see §5).
5. Consumers must tolerate broken links, unknown `type` values, and missing indexes, but **we do not rely on that tolerance**: this bundle aims for zero broken links and full index coverage, enforced by the lint pass (Phase 2).

**Repository meta vs. OKF concept docs.** `README.md`, `SCHEMA.md`, and `docs/*.md` are documentation; they still carry `type: overview` frontmatter so the whole tree is uniformly conformant. Tooling scripts and `raw/manifest.json` are tooling, not markdown concept docs.

**Both `sources:` and `videos:` are accepted.** The OKF concept/entity/source frontmatter spec uses a `sources:` key listing the source slugs that taught the item (provenance). An imported reference bundle may use the legacy `videos:` key for the same purpose; **both keys are accepted** by this bundle's lint and index passes, so an imported reference bundle still validates. New pages should prefer `sources:`.

## 3. Directory layout

```
<vault>/
├── index.md            # OKF root catalog (declares okf_version); read first after SCHEMA
├── SCHEMA.md           # this file — the maintainer contract
├── README.md           # human entry point + copy-paste consume prompt
├── log.md              # append-only ingestion history (reserved)
├── concepts/           # ideas, techniques, patterns, mental models
│   └── <concept-id>.md
├── entities/           # nameable things that exist
│   ├── tools/          # tools & products
│   ├── people/         # people
│   └── organizations/  # orgs
├── sources/            # one synthesized summary page per source (provenance)
│   └── <slug>.md
└── raw/                # immutable timestamped source material + manifest.json
    └── <slug>.md
```

**Why `entities/` is subdivided but `concepts/` is flat:** entities cleave cleanly into tools/people/orgs (aids the index and disambiguation); concepts do not partition cleanly, so they stay flat and are grouped *thematically in the index* instead of by folder.

**`.okf/` is pruned.** Every vault carries a private `.okf/` directory holding app state — settings, cache, and job records. **`.okf/` is pruned from the lint walk and from `buildIndexes()`**: it is not an OKF concept directory, its files are not linted, and it never appears in an index. Without this prune, every job record becomes an E1 error.

## 4. Page types & frontmatter schemas

All dates are ISO `YYYY-MM-DD`. `sources` (or the legacy `videos`) lists the source slugs that taught the item (provenance).

**Concept** (`concepts/<id>.md`)
```yaml
---
type: concept
title: "The PIV Loop"
description: "One-sentence definition used verbatim in index listings and search snippets."
tags: [workflow, planning, core]
sources: [complete-agentic-coding-workflow, principled-agentic-engineer]
created: 2026-10-17
updated: 2026-10-17
---
```

**Entity** (`entities/{tools,people,organizations}/<id>.md`) — add `resource` for a canonical URL/repo/homepage:
```yaml
---
type: entity
subtype: tool        # tool | person | organization
title: "Claude Code"
description: "Anthropic's terminal-based agentic coding tool."
resource: "https://www.anthropic.com/claude-code"
tags: [coding-agent, anthropic]
sources: [claude-code-hidden-features, claude-code-2000-hours]
created: 2026-10-17
updated: 2026-10-17
---
```

**Source** (`sources/<slug>.md`) — one per source:
```yaml
---
type: source
title: "Why the Best AI Coding Tools Abandoned RAG (And What They Use Instead)"
description: "One-sentence framing of the source's thesis."
url: https://www.youtube.com/watch?v=60G93MXT4DI
slug: why-ai-coding-abandoned-rag
published: 2026-05-14
raw: "../raw/why-ai-coding-abandoned-rag.md"
tags: [rag, retrieval]
created: 2026-10-17
updated: 2026-10-17
---
```

**Overview** (`SCHEMA.md`, `README.md`, `docs/*.md`): `type: overview`.

**Raw source** (`raw/<slug>.md`): `type: raw-source`, `immutable: true` — machine-written from the source; never hand-edited.

## 5. Linking & typed edges (the load-bearing discipline)

Relationships are what make this a wiki instead of a folder of notes. Rules:

- **Link with relative markdown paths:** from `concepts/x.md` to a tool -> `[Claude Code](../entities/tools/claude-code.md)`; to a sibling concept -> `[Agentic Coding](./agentic-coding.md)`.
- **Type every edge with the heading it lives under.** Because OKF links are untyped, we recover semantics from section headings. Canonical relationship headings:
  - `## Prerequisites` — what you must understand first
  - `## Builds on` / `## Part of` — the parent concept/loop
  - `## Contrasts with` — the thing it is defined against
  - `## Implemented by` / `## Tools` — entities that realize it
  - `## Related` — everything else worth a hop
  - `## Sources` — the `sources/` pages that taught it (provenance; every page ends with this)
- **Bidirectional:** if page A links to B under a typed heading, B links back to A. The lint pass reports orphan pages (no inbound links) so this stays honest.
- **Link density is a quality signal.** A concept/entity page with fewer than ~2 outbound links is under-developed. Link liberally.
- **Unresolved links are allowed as intent** but flagged by lint — prefer to create the target stub if a term recurs.

## 6. Atomicity, synthesis, and the page-creation threshold

- **One topic per page, captured in full.** Split a page past ~800-1000 words of distinct subtopics; merge two pages that cover the same thing.
- **Mine, don't mirror.** Never one page per source. Each source feeds many pages; each durable concept/entity is **one** page synthesizing *all* the sources that discuss it (each cited under `## Sources`).
- **Page-creation threshold = link-worthiness / reuse.** Give something its own page when it is linked-to from >=2 places or recurs across >=2 sources. Below that bar: a mention or an attribute inside a parent page, not a file.
- **Contradictions are flagged, never silently resolved.** If two sources conflict, add a `> **Contradiction:**` note on both pages citing the two sources and the date; let the reader judge. (Views that *evolve* over time are narrated, not flagged as contradictions.)

## 7. Index conventions

Every directory has an `index.md` — a grouped listing for progressive disclosure. Format per entry:
```markdown
- [Display Name](relative-path.md) — one-line description (copied from the target's frontmatter `description`)
```
Group under `##` headings (concepts by theme; entities by tool/person/org; sources by cluster). The **root `index.md` is the product** — invest in it: it is what an agent reads to decide where to go.

## 8. Ingestion workflow (reproducible)

For each source:
1. The immutable `raw/<slug>.md` is produced from the source.
2. Read this SCHEMA + `index.md` + the pages the source likely touches (synthesis, not dumping).
3. Write/refresh the `sources/<slug>.md` summary.
4. Create or update the concept/entity pages the source touches; wire typed links both directions.
5. Regenerate indexes, update the root coverage banner, and append to `log.md`.
6. Run the lint pass and fix everything it reports.

## 9. Validation

The lint pass (Phase 2 `packages/okf`) enforces, deterministically:
- E1: every non-reserved `.md` has frontmatter with a non-empty `type`;
- E2: every relative markdown link resolves to a file in the bundle;
- E3: every concept/entity/source page appears in its directory `index.md`;
- E4: every `sources/<slug>.md` has a matching `raw/<slug>.md` and vice-versa;
- E5: every source page's `source_kind` agrees with `youtube_id`;
- E6: no `## Sources` bullet cites a web source with a video timestamp (warning);
- E7: no `[[wikilink]]` survives in prose, with code spans and fences excluded;
- E8: every quoted citation appears in its cited raw material — within 45 seconds
  before and 120 seconds after a video timestamp, or anywhere in a web capture —
  at 55 percent word overlap, with the legacy `videos:` severity split;
- W1: no orphan concept/entity pages (warning).

Semantic checks (contradictions, staleness, missing concepts) are an LLM pass, not the script.

## Error codes

| Code | Meaning |
|------|---------|
| E1 | A non-reserved `.md` is missing frontmatter or its `type` is empty |
| E2 | A relative markdown link does not resolve to a file |
| E3 | A concept/entity/source page is absent from its directory `index.md` |
| E4 | A `sources/<slug>.md` has no matching `raw/<slug>.md` or vice-versa |
| E5 | A source page's `source_kind` and `youtube_id` disagree: a `web` source carries a `youtube_id`, or a `video` source lacks one |
| E6 | A `## Sources` bullet cites a web source but carries a video timestamp (warning) |
| E7 | A `[[wikilink]]` appears in prose; code spans and fenced blocks are excluded |
| E8 | Citation integrity: a quoted citation does not match the cited raw material, or a citation has no quote, a video citation has no timestamp, or the cited source or raw page is missing. On a page declaring `sources:` these are errors; on a legacy page declaring only `videos:`, only a bullet in the grammar `link - "[H:MM:SS] quote"` is scored, and a below-threshold quote is a warning |
| W1 | A concept/entity page has no inbound link from a non-index page (orphan, warning) |