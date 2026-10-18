/**
 * The immutable raw capture (T-03-03, PIPE-05).
 *
 * A capture is written once. A second run skips it only when the identity
 * matches: `youtube_id` for a video arm, `url` for a web arm. A mismatch, an
 * unparseable frontmatter block or a missing identity throws
 * `CaptureMismatchError` BEFORE the write, so a manually curated page is never
 * replaced.
 *
 * The exact CONTEXT frontmatter key mapping lives here and nowhere else: a
 * producer supplies a `RawCapture` arm and this module renders the keys. `title`
 * is TypeScript-only and never becomes a frontmatter key.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  formatTimestamp,
  parseFrontmatterSafe,
  renderFrontmatter,
} from "@2nd-brain/okf";
import type { OkfFrontmatter } from "@2nd-brain/okf";
import { writeTextAtomic } from "../http/writeAtomic.js";
import { resolveInVault } from "../paths/jail.js";
import type { RawCapture } from "./types.js";

export type CaptureMismatchReason = "capture_invalid" | "capture_identity_mismatch";

/** A refusal to overwrite an existing capture. Reason-only message. */
export class CaptureMismatchError extends Error {
  readonly reason: CaptureMismatchReason;

  constructor(reason: CaptureMismatchReason = "capture_identity_mismatch") {
    super("capture rejected");
    this.name = "CaptureMismatchError";
    this.reason = reason;
  }
}

export interface CaptureFile {
  /** Null when the file exists but its frontmatter is absent or unparseable. */
  frontmatter: OkfFrontmatter | null;
  body: string;
  raw: string;
}

/** Resolve `<vault>/raw/<slug>.md` through the jail. */
async function capturePath(
  vaultDir: string,
  slug: string,
): Promise<{ absPath: string; relPath: string }> {
  return resolveInVault(vaultDir, `raw/${slug}.md`);
}

/**
 * Read one capture, or `null` when the file does not exist. An existing file
 * with no parseable frontmatter is returned with `frontmatter: null` so the
 * caller can classify it as `capture_invalid` instead of treating it as absent.
 */
export async function readCapture(
  vaultDir: string,
  slug: string,
): Promise<CaptureFile | null> {
  const { absPath } = await capturePath(vaultDir, slug);
  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = parseFrontmatterSafe(raw);
  if (parsed === null) {
    return { frontmatter: null, body: "", raw };
  }
  return { frontmatter: parsed.data, body: parsed.body, raw };
}

export interface FoundCapture extends CaptureFile {
  slug: string;
}

/**
 * Find an existing web capture by the requested URL. Parses every `raw/*.md`
 * and never throws for a bad file. Makes no network call.
 */
export async function findCaptureByUrl(
  vaultDir: string,
  url: string,
): Promise<FoundCapture | null> {
  const { absPath: rawDir } = await resolveInVault(vaultDir, "raw");
  let names;
  try {
    names = await readdir(rawDir);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -".md".length);
    let found: CaptureFile | null;
    try {
      found = await readCapture(vaultDir, slug);
    } catch {
      continue;
    }
    if (!found?.frontmatter) continue;
    if (found.frontmatter.source_kind !== "web") continue;
    if (found.frontmatter.url !== url) continue;
    return { ...found, slug };
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The exact video frontmatter mapping, in CONTEXT order. */
function videoFrontmatter(capture: Extract<RawCapture, { kind: "video" }>): OkfFrontmatter {
  const data: OkfFrontmatter = {
    type: "raw-transcript",
    source_kind: "video",
    youtube_id: capture.youtubeId,
    url: capture.url,
    slug: capture.slug,
  };
  if (capture.published !== undefined) data.published = capture.published;
  if (capture.durationSec !== undefined) data.duration = capture.durationSec;
  data.fetched_at = capture.fetchedAt;
  data.tier = capture.tier;
  data.immutable = true;
  return data;
}

/** The exact web frontmatter mapping, in CONTEXT order. */
function webFrontmatter(capture: Extract<RawCapture, { kind: "web" }>): OkfFrontmatter {
  return {
    type: "raw-capture",
    source_kind: "web",
    url: capture.url,
    site: capture.site,
    slug: capture.slug,
    captured_at: capture.capturedAt,
    capture_kind: "page",
    word_count: capture.wordCount,
    immutable: true,
  };
}

function videoBody(capture: Extract<RawCapture, { kind: "video" }>): string {
  const paragraphs = capture.segments.map(
    (segment) => `**[${formatTimestamp(segment.startSec)}]** ${segment.text}`,
  );
  return `## Transcript\n\n${paragraphs.join("\n\n")}\n`;
}

function webBody(capture: Extract<RawCapture, { kind: "web" }>): string {
  // Paragraph anchors are assigned by `numberParagraphs` in `ingest/web.ts`,
  // because that is the only place that can tell a heading from prose. The
  // capture writer joins the already-anchored blocks instead of re-numbering
  // them, so a rendered capture carries exactly one `**[#n]**` per block.
  return `## Extracted text\n\n${capture.paragraphs.join("\n\n")}\n`;
}

export type WriteCaptureResult = { status: "written" } | { status: "skipped" };

/**
 * Write a capture, or skip it when an identity-matched file already exists.
 * Never rewrites an existing file.
 */
export async function writeCapture(
  vaultDir: string,
  capture: RawCapture,
): Promise<WriteCaptureResult> {
  const { absPath } = await capturePath(vaultDir, capture.slug);

  let existing: string | null = null;
  try {
    existing = await readFile(absPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existing !== null) {
    const parsed = parseFrontmatterSafe(existing);
    if (parsed === null) {
      throw new CaptureMismatchError("capture_invalid");
    }
    if (capture.kind === "video") {
      if (
        parsed.data.source_kind === "video" &&
        stringValue(parsed.data.youtube_id) === capture.youtubeId
      ) {
        return { status: "skipped" };
      }
      throw new CaptureMismatchError("capture_identity_mismatch");
    }
    if (
      parsed.data.source_kind === "web" &&
      stringValue(parsed.data.url) === capture.url
    ) {
      return { status: "skipped" };
    }
    throw new CaptureMismatchError("capture_identity_mismatch");
  }

  const frontmatter =
    capture.kind === "video" ? videoFrontmatter(capture) : webFrontmatter(capture);
  const body = capture.kind === "video" ? videoBody(capture) : webBody(capture);
  await writeTextAtomic(absPath, `${renderFrontmatter(frontmatter)}\n${body}`);
  return { status: "written" };
}

/** The capture path helper is exported for callers that only need the location. */
export { capturePath };
