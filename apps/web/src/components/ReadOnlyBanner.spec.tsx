import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReadOnlyBanner } from "./ReadOnlyBanner.js";
import { useStore, type AppState } from "../store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INITIAL: Partial<AppState> = {
  isReadOnly: false,
  health: null,
  healthError: null,
};

beforeEach(() => {
  useStore.setState(INITIAL as Partial<AppState>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders nothing when not read-only", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ReadOnlyBanner />);
  });
  expect(host.querySelector(".read-only-banner")).toBeNull();
  expect(host.textContent).toBe("");
});

it("renders banner with required message when read-only", async () => {
  useStore.setState({ isReadOnly: true });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ReadOnlyBanner />);
  });
  const banner = host.querySelector(".read-only-banner");
  expect(banner).toBeTruthy();
  expect(host.textContent).toContain("Read-Only Mode — Another instance is active. Mutations are disabled.");
});