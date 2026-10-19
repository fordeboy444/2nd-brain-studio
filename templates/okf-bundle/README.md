---
type: overview
title: "Knowledge Bundle"
description: "An Open Knowledge Format (OKF) bundle: a synthesized, densely cross-linked graph of concepts and entities mined from a source, not a raw dump."
tags: [readme, overview]
updated: 2026-10-17
---

# Knowledge Bundle

This is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) (OKF v0.1) bundle: a synthesized, densely cross-linked graph of concepts and entities mined from a source, not a raw dump.

## How to use it

1. Read `index.md` first — it groups every concept by theme and links to all sub-indexes.
2. Read `SCHEMA.md` for the page types and frontmatter contract.
3. Follow relative links into `concepts/`, `entities/`, and `sources/` to answer questions.
4. Every concept and entity page ends with a `## Sources` section citing the exact source(s) and timestamps the information came from. Always cite these when answering.

## Bundle layout

```
<vault>/
├── index.md        # OKF root catalog (declares okf_version); the entry point
├── SCHEMA.md       # the maintainer contract
├── README.md       # this file
├── log.md          # append-only ingestion history
├── concepts/       # ideas, techniques, patterns (one page per idea)
├── entities/       # tools, people, organizations
│   ├── tools/
│   ├── people/
│   └── organizations/
├── sources/        # one summary page per source (provenance)
└── raw/            # immutable source material + manifest.json
```

## Rules

- Navigate by index, not by loading everything. Open only the pages a question needs.
- Cross-links are relative markdown paths (never wikilinks) per OKF convention.
- If something is not covered in the knowledge base, say so instead of guessing.
- When answering, cite the concept/entity pages used and the source(s) they came from.
- Both `sources:` and `videos:` frontmatter keys are accepted (the latter for imported reference bundles).