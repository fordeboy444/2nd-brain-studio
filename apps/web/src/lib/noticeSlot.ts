/**
 * The ONE notice slot above the editor.
 *
 * Every top banner in the editor column used to render on its own, so several
 * could stack at once. Now each one says it WANTS the slot and only the
 * highest-priority wanting notice shows; when it goes (dismissed, faded or no
 * longer true) the next one in line shows.
 *
 * The reference app's priority list was account and sync notices (held bulk
 * delete, reconcile, membership lost, not-syncing, …) — every one of those
 * families is out of this app, so the list starts with the notices this app
 * actually raises. Later phases add theirs here, in priority order.
 */

/** How long an informational notice stays before it fades by itself. */
export const NOTICE_FADE_MS = 20_000;

/** Highest first. */
export const NOTICE_PRIORITY = [
  // The server reports degraded health: no Ollama API key configured.
  "config-degraded",
] as const;

export type NoticeId = (typeof NOTICE_PRIORITY)[number];

/** The notice that gets the slot: the highest-priority one that wants it. */
export function pickNotice(wanted: ReadonlySet<NoticeId>): NoticeId | null {
  for (const id of NOTICE_PRIORITY) if (wanted.has(id)) return id;
  return null;
}

const wanted = new Set<NoticeId>();
const listeners = new Set<() => void>();
let top: NoticeId | null = null;

function recompute(): void {
  const next = pickNotice(wanted);
  if (next === top) return;
  top = next;
  for (const l of [...listeners]) l();
}

/** A notice starts or stops wanting the slot. */
export function setNoticeWanted(id: NoticeId, on: boolean): void {
  if (on === wanted.has(id)) return;
  if (on) wanted.add(id);
  else wanted.delete(id);
  recompute();
}

/** The notice currently holding the slot. */
export function currentNotice(): NoticeId | null {
  return top;
}

export function subscribeNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: forget every claim. */
export function resetNoticeSlot(): void {
  wanted.clear();
  top = null;
  for (const l of [...listeners]) l();
}
