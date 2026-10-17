import type { ReactNode } from "react";

/**
 * Every banner in the app slides down out of the chrome it belongs to.
 *
 * The layout opening up for the message is the part that matters: a banner that
 * appears with `display: none → block` shoves the editor down by 44px in one
 * frame, and the eye reads that as the *content* jumping rather than as a
 * message arriving. `.banner-slot` does the opening; the `rise-in` keyframe
 * fades and lifts the strip inside it.
 *
 * Lives here rather than in `App.tsx` so components outside that file can use
 * the exact same shape instead of growing a second, subtly different strip.
 *
 * PORTED NOTE: the reference animated this with `motion` (a spring on `height`
 * plus `AnimatePresence` for the exit). `motion` is not a dependency of this app
 * — the phase's supply-chain review admits `jsdom` and nothing else — so the
 * entrance is the stylesheet's own `rise-in` keyframe and the exit is instant.
 * The props are unchanged, which is what the next plan depends on (D-07).
 */
export function Banner({
  children,
  show,
  className = "",
  role,
}: {
  children: ReactNode;
  show: boolean;
  className?: string;
  role?: "status" | "alert";
}) {
  if (!show) return null;
  return (
    <div className="banner-slot" style={{ animation: "rise-in var(--t-med) var(--ease) both" }}>
      <div className={`banner ${className}`.trim()} role={role}>
        {children}
      </div>
    </div>
  );
}
