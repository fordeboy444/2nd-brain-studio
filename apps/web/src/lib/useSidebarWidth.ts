import { useCallback, useEffect, useState } from "react";
import {
  clampSidebarWidth,
  readSidebarWidth,
  writeSidebarWidth,
} from "./sidebarWidth.js";

/**
 * The user's sidebar width, restored from localStorage and kept honest against
 * the window size.
 *
 * Lives apart from `SidebarResizer` because Fast Refresh gives up on a module
 * that exports both a component and a plain function — mixing them there cost a
 * full page reload on every edit to either.
 *
 * The width is handed to the layout as a CSS variable rather than kept in the
 * store: nothing outside the grid needs it, and routing a drag through global
 * state would re-render the whole tree on every pointer move.
 */
export function useSidebarWidth(): {
  width: number;
  setWidth: (px: number) => void;
} {
  const [width, setWidthState] = useState(readSidebarWidth);

  const setWidth = useCallback((px: number) => {
    const next = clampSidebarWidth(px, window.innerWidth);
    setWidthState(next);
    // Persist the clamped value: the stored width is what the next load
    // restores, so it must be the width the user actually got.
    writeSidebarWidth(next);
  }, []);

  // A window narrow enough to squeeze the editor pulls the sidebar back in with
  // it. The stored preference is deliberately left alone, so the width the user
  // chose returns when the window has room for it again.
  useEffect(() => {
    const onResize = () => setWidthState((w) => clampSidebarWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, setWidth };
}
