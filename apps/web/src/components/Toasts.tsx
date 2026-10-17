import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { dismissToast, useToasts, type Toast } from "../lib/toast.js";

/**
 * The toast viewport: bottom-right, above everything, never in the way of the
 * sidebar or the editor's own status row.
 *
 * Two details carry most of the feel:
 * - Toasts rise into place from the edge they live on, so the motion explains
 *   where they came from instead of just fading into existence.
 * - Hovering the stack **pauses every auto-dismiss**. Reaching for a message
 *   that then disappears under the cursor is the single most annoying thing a
 *   toast can do, and it's the reason people distrust them.
 *
 * PORTED NOTE: the reference stacked these with `motion`'s `AnimatePresence` and
 * a `layout` spring. `motion` is not a dependency of this app, so the entrance
 * is the stylesheet's `rise-in` keyframe and there is no exit animation. The
 * hover-pause and the portalling are unchanged.
 */
export function Toasts() {
  const toasts = useToasts();
  const hovering = useRef(false);

  // Portalled to <body> so no ancestor's stacking context can trap it under
  // a modal: an overlay's backdrop used to blur toasts out behind it.
  return createPortal(
    <div
      className="toast-viewport"
      onMouseEnter={() => {
        hovering.current = true;
      }}
      onMouseLeave={() => {
        hovering.current = false;
      }}
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} hovering={hovering} />
      ))}
    </div>,
    document.body,
  );
}

function ToastRow({
  toast,
  hovering,
}: {
  toast: Toast;
  hovering: React.RefObject<boolean>;
}) {
  // Auto-dismiss, deferred while the pointer is over the stack. Polling on a
  // slice of the ttl rather than one long timeout is what lets a hover extend
  // the life of a toast that was already halfway gone.
  useEffect(() => {
    if (toast.ttl === 0) return; // sticky (errors)
    let left = toast.ttl;
    const STEP = 100;
    const tick = window.setInterval(() => {
      if (hovering.current) return;
      left -= STEP;
      if (left <= 0) {
        window.clearInterval(tick);
        dismissToast(toast.id);
      }
    }, STEP);
    return () => window.clearInterval(tick);
  }, [toast.id, toast.ttl, hovering]);

  return (
    <div
      className={`toast toast-${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
      style={{ animation: "rise-in var(--t-fast) var(--ease) both" }}
    >
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">{toast.text}</span>
      <button
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => dismissToast(toast.id)}
      >
        ×
      </button>
    </div>
  );
}
