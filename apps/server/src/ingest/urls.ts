/**
 * YouTube channel URL normalization (INGEST-01).
 *
 * A job may only be created from a URL this module accepts. The accepted forms
 * are `@handle`, `/channel/<id>`, `/c/<name>` and `/user/<name>`, each with an
 * optional `/videos` tab. Every accepted form is canonicalized to the channel's
 * `/videos` tab, so S0 (which enumerates a channel) receives one shape and the
 * job record cannot store a URL the enumerator does not understand.
 *
 * Anything else — another host, another path shape, a non-http(s) protocol, or
 * an oversized input — is a 400 `invalid_source_url`, before any job exists.
 */

/** The longest input accepted. A longer string is rejected before parsing. */
const MAX_URL_LENGTH = 2048;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * One path segment identifying a channel, optionally followed by `/videos`.
 * `/channel/<id>` is its own two-segment shape; the others are one segment.
 */
const CHANNEL_PATH_RE =
  /^\/(@[A-Za-z0-9._-]+|channel\/[A-Za-z0-9._-]+|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)(?:\/videos)?\/?$/;

/** A URL that cannot be turned into a channel `/videos` URL. */
export class InvalidSourceUrlError extends Error {
  constructor(message = "Not a supported YouTube channel URL.") {
    super(message);
    this.name = "InvalidSourceUrlError";
  }
}

/**
 * Normalize an accepted channel URL to `https://www.youtube.com/<base>/videos`.
 * Query and fragment are discarded; `http:` is upgraded to `https:`.
 * Throws `InvalidSourceUrlError` for every rejected input.
 */
export function normalizeChannelUrl(input: string): string {
  if (typeof input !== "string") {
    throw new InvalidSourceUrlError();
  }
  // Length is checked on the raw input, before any parsing or trimming.
  if (input.length > MAX_URL_LENGTH) {
    throw new InvalidSourceUrlError("Source URL is too long.");
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new InvalidSourceUrlError();
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidSourceUrlError();
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidSourceUrlError("Only http and https URLs are accepted.");
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new InvalidSourceUrlError("Only YouTube channel URLs are accepted.");
  }

  const match = CHANNEL_PATH_RE.exec(url.pathname);
  const base = match?.[1];
  if (base === undefined) {
    throw new InvalidSourceUrlError("Only a channel, @handle, /c/ or /user/ URL is accepted.");
  }

  return `https://www.youtube.com/${base}/videos`;
}

/** True iff `normalizeChannelUrl(input)` succeeds. Never throws. */
export function isYouTubeChannelUrl(input: string): boolean {
  try {
    normalizeChannelUrl(input);
    return true;
  } catch {
    return false;
  }
}
