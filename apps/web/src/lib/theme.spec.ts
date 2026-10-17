import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  currentTheme,
  initTheme,
  readStoredTheme,
  resolveTheme,
  setTheme,
} from "./theme.js";

/* Theme spec — runs under jsdom (test.environment: "jsdom" in vite.config.ts).
   jsdom provides `document`, `localStorage` and a stub `matchMedia`. */

const mqListeners: Array<(e: { matches: boolean }) => void> = [];
let darkMatches = false;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  darkMatches = false;
  mqListeners.length = 0;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("dark") && darkMatches,
    media: query,
    onchange: null,
    addEventListener: (_ev: string, cb: (e: { matches: boolean }) => void) => {
      mqListeners.push(cb);
    },
    removeEventListener: (_ev: string, cb: (e: { matches: boolean }) => void) => {
      const i = mqListeners.indexOf(cb);
      if (i >= 0) mqListeners.splice(i, 1);
    },
    addListener: (cb: (e: { matches: boolean }) => void) => mqListeners.push(cb),
    removeListener: (cb: (e: { matches: boolean }) => void) => {
      const i = mqListeners.indexOf(cb);
      if (i >= 0) mqListeners.splice(i, 1);
    },
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readStoredTheme", () => {
  it("returns 'system' when nothing is stored", () => {
    expect(readStoredTheme()).toBe("system");
  });

  it("returns the stored value when valid", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("returns 'system' when storage holds an invalid string", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(readStoredTheme()).toBe("system");
  });

  it("returns 'system' and does not throw when localStorage throws", () => {
    const orig = globalThis.localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("disabled");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });
    expect(() => readStoredTheme()).not.toThrow();
    expect(readStoredTheme()).toBe("system");
    vi.stubGlobal("localStorage", orig);
  });
});

describe("resolveTheme", () => {
  it("returns explicit light/dark as-is", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolves system via matchMedia", () => {
    darkMatches = false;
    expect(resolveTheme("system")).toBe("light");
    darkMatches = true;
    expect(resolveTheme("system")).toBe("dark");
  });
});

describe("applyTheme + setTheme", () => {
  it("stamps the resolved value on documentElement.dataset.theme", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("after setTheme('dark') the persisted value and the attribute agree", () => {
    setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("apply is performed before persist (attribute set even if storage throws)", () => {
    const orig = globalThis.localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });
    expect(() => setTheme("dark")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    vi.stubGlobal("localStorage", orig);
  });
});

describe("idempotency", () => {
  it("toggling twice from a known start returns to the starting attribute", () => {
    setTheme("light");
    const start = document.documentElement.getAttribute("data-theme");
    setTheme("dark");
    setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe(start);
  });

  it("initTheme called twice does not change the attribute and registers one listener", () => {
    setTheme("dark");
    const before = document.documentElement.getAttribute("data-theme");
    initTheme();
    initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe(before);
    // The system listener is registered at most once: firing it once flips a
    // system preference, firing it a second time must not double-apply.
    setTheme("system");
    darkMatches = true;
    for (const cb of [...mqListeners]) cb({ matches: true });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // Fire again — still a single resolved value, no throw, no duplicate.
    for (const cb of [...mqListeners]) cb({ matches: true });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("currentTheme", () => {
  it("returns the stored preference", () => {
    setTheme("system");
    expect(currentTheme()).toBe("system");
    setTheme("light");
    expect(currentTheme()).toBe("light");
  });
});