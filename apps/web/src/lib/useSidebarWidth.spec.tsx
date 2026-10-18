import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useSidebarWidth } from "./useSidebarWidth.js";
import { SIDEBAR_WIDTH_KEY } from "./sidebarWidth.js";

/**
 * The resizer's one promise: a narrow window may squeeze the sidebar, but it
 * must not overwrite the width the user chose. The shown width comes back when
 * the window has room again, and the stored preference never becomes the
 * squeezed value.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let latest: { width: number; setWidth: (px: number) => void };

function Probe() {
  latest = useSidebarWidth();
  return null;
}

function setViewport(px: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: px,
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1200,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("restores the chosen width after the window shrinks and grows again", () => {
  act(() => latest.setWidth(500));
  expect(latest.width).toBe(500);

  // 700 - 320 = 380, the room this window leaves for the sidebar.
  setViewport(700);
  expect(latest.width).toBe(380);

  setViewport(1600);
  expect(latest.width).toBe(500);
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("500");
});

it("keeps the preference when a resize clamps the shown width", () => {
  act(() => latest.setWidth(560));
  setViewport(700);
  expect(latest.width).toBe(380);
  // The stored value is the preference, not the width the window allowed.
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("560");
});

it("restores a wide stored preference when the window can show it", () => {
  // The preference is read on mount, so store it first and mount again.
  act(() => root.unmount());
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "520");
  setViewport(700);
  root = createRoot(host);
  act(() => root.render(<Probe />));

  expect(latest.width).toBe(380);
  setViewport(1600);
  expect(latest.width).toBe(520);
});
