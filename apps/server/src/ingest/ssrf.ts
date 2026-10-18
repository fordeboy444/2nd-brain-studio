/**
 * The web ingest boundary (T-03-19, T-03-23).
 *
 * A web job accepts an arbitrary URL, so this module is the only place a
 * server-side request may originate. Two checks, in this order:
 *
 * 1. Syntax: only `http:`/`https:`, no embedded credentials, a bounded
 *    hostname. `parseWebUrl` makes no network call.
 * 2. Address: every address a hostname resolves to must be public.
 *    `assertPublicHttpUrl` runs this before the first request and again for
 *    every redirect target, so a redirect cannot route around the guard.
 *
 * There is no third-party IP library: `node:net.isIP` plus octet and prefix
 * arithmetic are the whole classifier. An address that is not a valid IP fails
 * closed.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Why a URL or response was refused. */
export type SsrfReason =
  | "scheme"
  | "credentials"
  | "dns_error"
  | "private_address"
  | "redirect_limit"
  | "unsupported_content_type"
  | "body_too_large"
  | "timeout";

/** A refusal at the web boundary. `reason` is stable and testable. */
export class SsrfError extends Error {
  readonly reason: SsrfReason;

  constructor(reason: SsrfReason, message?: string) {
    super(message ?? defaultMessage(reason));
    this.name = "SsrfError";
    this.reason = reason;
  }
}

function defaultMessage(reason: SsrfReason): string {
  switch (reason) {
    case "scheme":
      return "Only http and https URLs are accepted.";
    case "credentials":
      return "URLs with embedded credentials are rejected.";
    case "dns_error":
      return "The host could not be resolved.";
    case "private_address":
      return "The host is not a public address.";
    case "redirect_limit":
      return "The page redirected too many times.";
    case "unsupported_content_type":
      return "The response is not an HTML page.";
    case "body_too_large":
      return "The response body exceeds 5 MiB.";
    case "timeout":
      return "The request timed out.";
  }
}

export interface LookupAddress {
  address: string;
  family: number;
}

/** The injectable DNS seam. The default is the real resolver. */
export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export interface SsrfDeps {
  lookup?: LookupFn;
}

const MAX_URL_LENGTH = 2048;
const MAX_HOSTNAME_LENGTH = 253;

const defaultLookup: LookupFn = (hostname, options) =>
  dnsLookup(hostname, options) as Promise<LookupAddress[]>;

/**
 * Parse a web source URL. Accepts `http:`/`https:` only and refuses an
 * embedded `user:password`. No DNS lookup happens here, so a preview or a job
 * create can call this without a network request.
 */
export function parseWebUrl(input: string): URL {
  if (typeof input !== "string") {
    throw new SsrfError("scheme", "Only http and https URLs are accepted.");
  }
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LENGTH) {
    throw new SsrfError("scheme", "Only http and https URLs are accepted.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SsrfError("scheme", "Only http and https URLs are accepted.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("scheme", "Only http and https URLs are accepted.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SsrfError("credentials", "URLs with embedded credentials are rejected.");
  }
  if (url.hostname === "" || url.hostname.length > MAX_HOSTNAME_LENGTH) {
    throw new SsrfError("scheme", "The hostname is missing or too long.");
  }
  return url;
}

/** Octets as one unsigned 32-bit integer, or null when the text is not IPv4. */
function ipv4ToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** The four IPv4 octets, or null. Used for an embedded IPv4 IPv6 tail. */
function ipv4Parts(text: string): number[] | null {
  if (!text.includes(".") || isIP(text) !== 4) return null;
  return text.split(".").map((part) => Number(part));
}

/**
 * Expand an IPv6 literal into eight 16-bit groups. Handles `::` compression and
 * an embedded dotted-quad tail (`::ffff:127.0.0.1`). Returns null when the
 * text is not a well-formed IPv6 address.
 */
function ipv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  const text = ip.replace(/%.*$/, "");
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const expandTail = (groups: string[]): string[] | null => {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1] as string;
    if (!last.includes(".")) return groups;
    const parts = ipv4Parts(last);
    if (parts === null) return null;
    return [
      ...groups.slice(0, -1),
      (((parts[0] as number) << 8) | (parts[1] as number)).toString(16),
      (((parts[2] as number) << 8) | (parts[3] as number)).toString(16),
    ];
  };

  const head = expandTail(halves[0] === "" ? [] : (halves[0] as string).split(":"));
  const tail =
    halves.length === 2
      ? expandTail(halves[1] === "" ? [] : (halves[1] as string).split(":"))
      : [];
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (halves.length === 2) {
    if (missing < 0) return null;
  } else if (missing !== 0) {
    return null;
  }

  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.length !== 8) return null;

  const groups: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  return groups;
}

/** The private, loopback, link-local, unique-local and reserved IPv4 ranges. */
function isPrivateIpv4(value: number): boolean {
  return (
    (value >>> 24) === 0 || // 0.0.0.0/8
    (value >>> 24) === 10 || // 10/8
    ((value & 0xffc00000) >>> 0) === 0x64400000 || // 100.64/10
    (value >>> 24) === 127 || // 127/8
    ((value & 0xffff0000) >>> 0) === 0xa9fe0000 || // 169.254/16
    ((value & 0xfff00000) >>> 0) === 0xac100000 || // 172.16/12
    ((value & 0xffffff00) >>> 0) === 0xc0000000 || // 192.0.0.0/24
    ((value & 0xffff0000) >>> 0) === 0xc0a80000 || // 192.168/16
    ((value & 0xfffe0000) >>> 0) === 0xc6120000 || // 198.18/15
    (value >>> 28) === 0xe || // 224/4
    (value >>> 28) === 0xf // 240/4
  );
}

/**
 * True when the address must never be requested. Not-an-IP fails closed, so a
 * malformed resolver result cannot slip through as public.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const value = ipv4ToInt(ip);
    return value === null || isPrivateIpv4(value);
  }
  if (version === 6) {
    const groups = ipv6Groups(ip);
    if (groups === null) return true;

    // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) carry an
    // IPv4 address in the final 32 bits; classify that address, not the shell.
    const highZero = groups.slice(0, 5).every((group) => group === 0);
    if (highZero && groups[5] === 0xffff) {
      const value = (((groups[6] as number) << 16) | (groups[7] as number)) >>> 0;
      return isPrivateIpv4(value);
    }
    if (highZero && groups[5] === 0) {
      const value = (((groups[6] as number) << 16) | (groups[7] as number)) >>> 0;
      // `::` is unspecified and `::1` is loopback; both are private anyway.
      return value === 0 ? true : isPrivateIpv4(value);
    }
    if (((groups[0] as number) & 0xfe00) === 0xfc00) return true; // fc00::/7
    if (((groups[0] as number) & 0xffc0) === 0xfe80) return true; // fe80::/10
    if (((groups[0] as number) & 0xff00) === 0xff00) return true; // ff00::/8
    return false;
  }
  return true;
}

export interface PublicUrl {
  url: URL;
  addresses: string[];
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * Validate a URL's scheme, credentials and every resolved address. The check
 * runs before the first request and again for every redirect target.
 *
 * A private result names only the host: the resolved address is not echoed into
 * a message that could reach an event log.
 */
export async function assertPublicHttpUrl(
  input: URL | string,
  deps: SsrfDeps = {},
): Promise<PublicUrl> {
  const url = parseWebUrl(typeof input === "string" ? input : input.toString());
  const hostname = hostnameOf(url);

  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new SsrfError("private_address", `Host "${hostname}" is not a public address.`);
    }
    return { url, addresses: [hostname] };
  }

  let resolved: LookupAddress[];
  try {
    resolved = await (deps.lookup ?? defaultLookup)(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError("dns_error", `Host "${hostname}" could not be resolved.`);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new SsrfError("dns_error", `Host "${hostname}" could not be resolved.`);
  }

  for (const entry of resolved) {
    if (isPrivateAddress(entry.address)) {
      throw new SsrfError("private_address", `Host "${hostname}" is not a public address.`);
    }
  }

  return { url, addresses: resolved.map((entry) => entry.address) };
}
