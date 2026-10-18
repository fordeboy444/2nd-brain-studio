/**
 * Web page ingest: one guarded request, one Readability extraction, one
 * paragraph-numbered markdown body.
 *
 * The extraction is deterministic on purpose: Readability picks the article,
 * turndown converts it to ATX markdown, and `numberParagraphs` assigns the
 * `**[#n]**` anchors that a claim later cites. The raw capture is written by
 * the runner, which is also what makes it immutable.
 */
import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { slugify } from "@2nd-brain/okf";
import {
  assertPublicHttpUrl,
  parseWebUrl,
  SsrfError,
  type LookupFn,
} from "./ssrf.js";

/** A page smaller than this is not worth a capture. */
export const MIN_CONTENT_CHARS = 20;
/** A capture below this many words is still written, but flagged. */
export const SHORT_PAGE_WORDS = 200;
/** One hop's ceiling; a redirect chain resets the clock per hop. */
export const FETCH_TIMEOUT_MS = 30_000;
/** The whole decoded body may not exceed this. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Follow at most five redirects before refusing. */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const USER_AGENT = "2nd-brain-studio/0.1 (+web ingest)";

/** The page carried no usable article text. Maps to `empty_transcript`. */
export class WebContentError extends Error {
  readonly reason = "empty_transcript" as const;

  constructor(message = "The page has no readable article text.") {
    super(message);
    this.name = "WebContentError";
  }
}

/** A non-2xx response. Carried separately so the classifier can see the code. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The page returned HTTP ${status}.`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export interface WebFetchContext {
  signal: AbortSignal;
}

export interface WebFetchDeps {
  fetch?: typeof globalThis.fetch;
  lookup?: LookupFn;
}

export interface FetchedPage {
  /** The URL that actually served the page, after every followed redirect. */
  finalUrl: string;
  html: string;
}

export interface ExtractedPage {
  title: string;
  markdown: string;
  paragraphs: string[];
  wordCount: number;
  warning?: "short_page";
}

interface Hop {
  signal: AbortSignal;
  dispose: () => void;
}

/**
 * One hop's signal: the unit's cancellation plus a 30 s timer. The timer is
 * always cleared by `dispose`, so a completed fetch leaves nothing pending.
 */
function hopSignal(outer: AbortSignal): Hop {
  const controller = new AbortController();
  const abortFromOuter = (): void => controller.abort(outer.reason);
  if (outer.aborted) {
    abortFromOuter();
  } else {
    outer.addEventListener("abort", abortFromOuter, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The page fetch timed out after 30 s.", "TimeoutError"));
  }, FETCH_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      outer.removeEventListener("abort", abortFromOuter);
    },
  };
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

async function discardBody(response: Response): Promise<void> {
  if (response.body === null) return;
  await response.body.cancel().catch(() => undefined);
}

/** Stream the body with a hard cap, so a chunked reply cannot bypass it. */
async function readCappedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SsrfError("body_too_large", "The page body exceeds 5 MiB.");
      }
      html += decoder.decode(chunk, { stream: true });
    }
    html += decoder.decode();
    return html;
  } catch (error) {
    if (error instanceof SsrfError) throw error;
    if (isAbortError(error) || signal.aborted) {
      throw new SsrfError("timeout", "The page fetch timed out after 30 s.");
    }
    throw error;
  }
}

/**
 * Fetch one page through the SSRF guard. Redirects are followed manually, at
 * most five times, and every redirect target is re-validated before it is
 * requested.
 */
export async function fetchWebPage(
  input: string | URL,
  ctx: WebFetchContext,
  deps: WebFetchDeps = {},
): Promise<FetchedPage> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const first = parseWebUrl(typeof input === "string" ? input : input.toString());
  await assertPublicHttpUrl(first, { lookup: deps.lookup });

  let current = first;
  for (let redirects = 0; ; redirects += 1) {
    const hop = hopSignal(ctx.signal);
    try {
      let response: Response;
      try {
        response = await fetchImpl(current, {
          redirect: "manual",
          signal: hop.signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
        });
      } catch (error) {
        if (isAbortError(error) || hop.signal.aborted) {
          throw new SsrfError("timeout", "The page fetch timed out after 30 s.");
        }
        throw error;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await discardBody(response);
        if (location === null || location.trim() === "") {
          throw new SsrfError("redirect_limit", "The redirect has no Location header.");
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new SsrfError("redirect_limit", "The page redirected more than five times.");
        }

        let target: URL;
        try {
          target = new URL(location, current);
        } catch {
          throw new SsrfError("scheme", "The redirect target is not a valid URL.");
        }
        // `parseWebUrl` rejects a non-http(s) target with reason `scheme`.
        current = parseWebUrl(target.toString());
        // Every hop re-runs the full address check, not just the syntax check.
        await assertPublicHttpUrl(current, { lookup: deps.lookup });
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        await discardBody(response);
        throw new HttpStatusError(response.status);
      }

      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType === undefined || !HTML_CONTENT_TYPES.has(contentType)) {
        await discardBody(response);
        throw new SsrfError(
          "unsupported_content_type",
          `Unsupported content type "${contentType ?? "unknown"}".`,
        );
      }

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        await discardBody(response);
        throw new SsrfError("body_too_large", "The page body exceeds 5 MiB.");
      }

      const html = await readCappedBody(response, hop.signal);
      return { finalUrl: current.toString(), html };
    } finally {
      hop.dispose();
    }
  }
}

/**
 * Turn markdown into numbered blocks. Headings stay unnumbered; each non-empty
 * non-heading block gets the next `**[#n]**` anchor. The anchor lives in the
 * capture body, so a later citation can name `[#3]` without re-parsing HTML.
 */
export function numberParagraphs(markdown: string): string[] {
  const numbered: string[] = [];
  let anchor = 0;
  for (const raw of markdown.split(/\n{2,}/)) {
    const block = raw.trim();
    if (block === "") continue;
    if (block.startsWith("#")) {
      numbered.push(block);
      continue;
    }
    anchor += 1;
    numbered.push(`**[#${anchor}]** ${block}`);
  }
  return numbered;
}

/** Word count over the body, with the anchor markers and markup removed. */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/\*\*\[#[0-9]+\]\*\*/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()!|]/g, " ");
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "page";
  }
}

/**
 * A stable, filesystem-safe slug: the title's slug plus six hex characters of
 * the requested URL's hash. The hash keeps two pages with the same title apart
 * and is stable across retries, so a resumed run writes the same filename.
 */
export function webSlug(title: string, requestedUrl: string, site?: string): string {
  const source = title.trim() !== "" ? title.trim() : (site ?? hostnameOf(requestedUrl));
  let base: string;
  try {
    base = slugify(source);
  } catch {
    base = "page";
  }
  base = base.slice(0, 60).replace(/-+$/, "");
  if (base === "") base = "page";
  const suffix = createHash("sha256").update(requestedUrl).digest("hex").slice(0, 6);
  return `${base}-${suffix}`;
}

/**
 * Extract the readable article. A DOM is built without scripts and without
 * resource loading; only the parsed document is ever touched.
 */
export function extractReadable(html: string, finalUrl: string): ExtractedPage {
  const dom = new JSDOM(html, { url: finalUrl });
  try {
    const document = dom.window.document;
    const article = new Readability(document).parse();
    const text = article?.textContent?.trim() ?? "";
    if (article === null || text.length < MIN_CONTENT_CHARS) {
      throw new WebContentError();
    }

    const title = (article.title?.trim() || document.title?.trim() || "").trim();
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    const markdown = turndown.turndown(article.content ?? "").trim();
    if (markdown.length < MIN_CONTENT_CHARS) {
      throw new WebContentError();
    }

    const wordCount = countWords(markdown);
    const extracted: ExtractedPage = {
      title,
      markdown,
      paragraphs: numberParagraphs(markdown),
      wordCount,
    };
    if (wordCount < SHORT_PAGE_WORDS) extracted.warning = "short_page";
    return extracted;
  } finally {
    dom.window.close();
  }
}
