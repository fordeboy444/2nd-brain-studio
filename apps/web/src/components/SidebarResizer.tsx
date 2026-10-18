import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../lib/sidebarWidth.js";

/**
 * The sidebar's resize handle.
 *
 * The width lives in `useSidebarWidth` and reaches the layout as a CSS
 * variable, so a drag only repaints the grid column that moved. This
 * component owns the pointer gesture and the accessible separator role; it
 * holds no width of its own.
 *
 * Keyboard: Left/Right step by 16px, Home and End jump to the bounds.
 */
const KEYBOARD_STEP = 16;

export function SidebarResizer({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (px: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    // Capture so the drag keeps working when the pointer crosses the editor.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (drag.current === null) return;
    onWidthChange(drag.current.startWidth + (e.clientX - drag.current.startX));
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (drag.current === null) return;
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = width - KEYBOARD_STEP;
    else if (e.key === "ArrowRight") next = width + KEYBOARD_STEP;
    else if (e.key === "Home") next = SIDEBAR_WIDTH_MIN;
    else if (e.key === "End") next = SIDEBAR_WIDTH_MAX;
    if (next === null) return;
    e.preventDefault();
    onWidthChange(next);
  }

  return (
    <div
      className={`sidebar-resizer${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={Math.round(width)}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
