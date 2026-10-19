/**
 * The pinned HTTPS path (WR-06). `node:https.request` is replaced so the spec
 * can inspect the exact TLS options that reach Node: `pinnedFetch` dials the
 * guarded address and must pass a bare IP as `servername`.
 */
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return {
    ...actual,
    request: (
      _url: URL,
      options: Record<string, unknown>,
      callback: (res: unknown) => void,
    ) => {
      captured.options = options;
      const response = {
        socket: { remoteAddress: "::1" },
        statusCode: 204,
        statusMessage: "No Content",
        headers: {},
        resume: () => undefined,
      };
      return {
        on: () => undefined,
        end: () => callback(response),
      };
    },
  };
});

import { pinnedFetch } from "./web.js";

describe("pinnedFetch HTTPS servername", () => {
  it("strips the IPv6 brackets so Node performs the IP identity check", async () => {
    const response = await pinnedFetch(new URL("https://[::1]/page"), {
      pinnedAddresses: ["::1"],
    });

    expect(response.status).toBe(204);
    // `new URL(...).hostname` is "[::1]"; Node must receive "::1".
    expect(captured.options?.servername).toBe("::1");
  });
});
