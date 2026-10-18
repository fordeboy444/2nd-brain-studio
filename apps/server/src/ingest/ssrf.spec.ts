import { describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpUrl,
  isPrivateAddress,
  parseWebUrl,
  SsrfError,
  type LookupFn,
} from "./ssrf.js";
import { fetchWebPage } from "./web.js";

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

function asFetch(
  fn: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return fn as unknown as typeof globalThis.fetch;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function htmlResponse(body = "<html><body><p>real content</p></body></html>"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

describe("parseWebUrl", () => {
  it("accepts http and https and normalizes the scheme", () => {
    expect(parseWebUrl("https://example.com/page?q=1").toString()).toBe(
      "https://example.com/page?q=1",
    );
    expect(parseWebUrl("HTTP://Example.COM/Path").protocol).toBe("http:");
    expect(parseWebUrl("  https://example.com/x  ").pathname).toBe("/x");
  });

  it.each([
    ["file:///etc/passwd", "scheme"],
    ["ftp://example.com/file", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,hi", "scheme"],
    ["", "scheme"],
    ["not a url", "scheme"],
    ["//example.com/no-scheme", "scheme"],
    [`https://${"a".repeat(250)}.com`, "scheme"],
  ])("refuses %s with reason %s", (input, reason) => {
    expect(() => parseWebUrl(input)).toThrow(
      expect.objectContaining({ name: "SsrfError", reason }),
    );
  });

  it.each(["https://user:secret@example.com/x", "https://user@example.com/x"])(
    "refuses embedded credentials in %s",
    (input) => {
      expect(() => parseWebUrl(input)).toThrow(
        expect.objectContaining({ reason: "credentials" }),
      );
    },
  );
});

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.0.255",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "100.63.255.255",
    "172.15.255.255",
    "172.32.0.0",
    "169.253.255.255",
    "192.0.1.1",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:db8::1",
    "::ffff:8.8.8.8",
  ])("treats %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("fails closed on anything that is not an IP address", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
    expect(isPrivateAddress("999.1.1.1")).toBe(true);
    expect(isPrivateAddress("example.com")).toBe(true);
  });
});

describe("assertPublicHttpUrl", () => {
  it("returns every address a public host resolves to", async () => {
    const lookup = vi.fn<LookupFn>(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    const result = await assertPublicHttpUrl("https://example.com/x", { lookup });

    expect(lookup).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
    expect(result.addresses).toEqual([
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ]);
  });

  it("checks a public IP literal without a DNS lookup", async () => {
    const lookup = vi.fn<LookupFn>(publicLookup);

    const result = await assertPublicHttpUrl("http://93.184.216.34/x", { lookup });

    expect(lookup).not.toHaveBeenCalled();
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("refuses a private IP literal without a DNS lookup", async () => {
    const lookup = vi.fn<LookupFn>(publicLookup);

    await expect(assertPublicHttpUrl("http://127.0.0.1/x", { lookup })).rejects.toMatchObject({
      reason: "private_address",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects when one resolved address is private", async () => {
    const lookup: LookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];

    const error = await failureOf(assertPublicHttpUrl("https://internal.example/x", { lookup }));

    expect(error).toBeInstanceOf(SsrfError);
    expect((error as SsrfError).reason).toBe("private_address");
    // The host may be named; the resolved address must not be echoed.
    expect((error as Error).message).toContain("internal.example");
    expect((error as Error).message).not.toContain("10.0.0.5");
  });

  it.each(["file:///etc/passwd", "ftp://example.com/x"])(
    "rejects %s before any lookup",
    async (input) => {
      const lookup = vi.fn<LookupFn>(publicLookup);

      await expect(assertPublicHttpUrl(input, { lookup })).rejects.toMatchObject({
        reason: "scheme",
      });
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("rejects an embedded credential before any lookup", async () => {
    const lookup = vi.fn<LookupFn>(publicLookup);

    await expect(
      assertPublicHttpUrl("http://user:pass@example.com/x", { lookup }),
    ).rejects.toMatchObject({ reason: "credentials" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("maps a resolver failure to dns_error", async () => {
    const lookup: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };

    await expect(assertPublicHttpUrl("https://missing.example/x", { lookup })).rejects.toMatchObject({
      reason: "dns_error",
    });
  });

  it("treats an empty resolver answer as dns_error", async () => {
    const lookup: LookupFn = async () => [];

    await expect(assertPublicHttpUrl("https://empty.example/x", { lookup })).rejects.toMatchObject({
      reason: "dns_error",
    });
  });
});

describe("fetchWebPage redirects (T-03-19)", () => {
  const ctx = { signal: new AbortController().signal };

  it("re-validates a redirect target before fetching it", async () => {
    const lookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
    const fetchImpl = vi.fn(
      asFetch(async () => redirect("http://169.254.169.254/latest/meta-data/")),
    );

    await expect(
      fetchWebPage("https://public.example/start", ctx, { fetch: fetchImpl, lookup }),
    ).rejects.toMatchObject({ reason: "private_address" });

    // The private hop was never requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /** A chain where path `/n` redirects to `/n+1` until `limit`, then HTML. */
  function chainFetch(limit: number): ReturnType<typeof vi.fn> {
    return vi.fn(
      asFetch(async (input) => {
        const url = String(input);
        const index = Number(url.slice(url.lastIndexOf("/") + 1));
        if (index < limit) return redirect(`https://public.example/${index + 1}`);
        return htmlResponse();
      }),
    );
  }

  it("rejects a redirect to file: with scheme and never performs a second fetch", async () => {
    const fetchImpl = vi.fn(
      asFetch(async () => redirect("file:///etc/passwd")),
    );

    await expect(
      fetchWebPage("https://public.example/start", ctx, { fetch: fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "scheme" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to ftp: with scheme", async () => {
    const fetchImpl = vi.fn(
      asFetch(async () => redirect("ftp://public.example/archive")),
    );

    await expect(
      fetchWebPage("https://public.example/start", ctx, { fetch: fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "scheme" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect with no Location header as redirect_limit", async () => {
    const fetchImpl = vi.fn(asFetch(async () => new Response(null, { status: 302 })));

    await expect(
      fetchWebPage("https://public.example/start", ctx, { fetch: fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "redirect_limit" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows a chain of five redirects", async () => {
    const fetchImpl = chainFetch(5);

    const page = await fetchWebPage("https://public.example/0", ctx, {
      fetch: fetchImpl,
      lookup: publicLookup,
    });

    expect(page.finalUrl).toBe("https://public.example/5");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("fails the sixth redirect with redirect_limit", async () => {
    const fetchImpl = chainFetch(6);

    await expect(
      fetchWebPage("https://public.example/0", ctx, { fetch: fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "redirect_limit" });

    // Initial request plus five followed redirects; the sixth was not requested.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("re-runs the full DNS check for every redirect hop", async () => {
    const lookup = vi.fn<LookupFn>(publicLookup);
    const fetchImpl = chainFetch(2);

    await fetchWebPage("https://public.example/0", ctx, { fetch: fetchImpl, lookup });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledTimes(3);
    for (const call of lookup.mock.calls) {
      expect(call[1]).toEqual({ all: true, verbatim: true });
    }
  });

  it("requests with redirect manual and an abort signal", async () => {
    const fetchImpl = vi.fn(asFetch(async () => htmlResponse()));

    const page = await fetchWebPage("https://public.example/x", ctx, {
      fetch: fetchImpl,
      lookup: publicLookup,
    });

    expect(page.finalUrl).toBe("https://public.example/x");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
