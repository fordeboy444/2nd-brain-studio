/**
 * The S1w web stage (PIPE-05, T-03-19).
 *
 * One guarded fetch, one extraction, one web arm. The runner owns the capture
 * write and its immutability check; this module owns the network and the
 * classifier for a web failure.
 *
 * The classifier is only a fallback: an `SsrfError` or `WebContentError` named
 * the reason already, and the runner prefers a tagged `SkipError` when one is
 * thrown.
 */
import {
  extractReadable,
  fetchWebPage,
  HttpStatusError,
  WebContentError,
  webSlug,
  type WebFetchDeps,
} from "../../ingest/web.js";
import { SsrfError } from "../../ingest/ssrf.js";
import type { SkipReason } from "../types.js";
import type { UnitContext, WebFetchResult } from "../runner.js";

export type WebFetcher = (
  input: { url: string },
  ctx: UnitContext,
) => Promise<WebFetchResult>;

/**
 * Build the S1w fetcher. `fetch` and `lookup` are injectable so every spec
 * stays off the network.
 */
export function createWebFetcher(deps: WebFetchDeps = {}): WebFetcher {
  return async (input, ctx) => {
    const { finalUrl, html } = await fetchWebPage(input.url, ctx, deps);
    const page = extractReadable(html, finalUrl);
    const site = new URL(finalUrl).hostname;
    const capture: WebFetchResult = {
      site,
      title: page.title,
      paragraphs: page.paragraphs,
      wordCount: page.wordCount,
      capturedAt: new Date(ctx.now()).toISOString(),
      // The requested URL, not the final one, is the capture identity: a
      // redirect must not make a resumed run look like a different unit.
      slug: webSlug(page.title, input.url, site),
    };
    if (page.warning !== undefined) capture.warning = page.warning;
    return capture;
  };
}

/**
 * Map a web-stage failure to the shared skip taxonomy.
 *
 * - a timeout is a timeout
 * - an unreadable page is `empty_transcript`
 * - 401/403/429 mean the page refused automated access: `blocked`
 * - 408/504 are upstream timeouts
 * - everything else (DNS, private address, bad scheme, body cap, 5xx) is a
 *   `fetch_error`
 */
export function classifyWebError(error: unknown): SkipReason {
  if (error instanceof SsrfError) {
    return error.reason === "timeout" ? "timeout" : "fetch_error";
  }
  if (error instanceof WebContentError) return "empty_transcript";
  if (error instanceof HttpStatusError) {
    if (error.status === 401 || error.status === 403 || error.status === 429) return "blocked";
    if (error.status === 408 || error.status === 504) return "timeout";
    return "fetch_error";
  }
  return "fetch_error";
}
