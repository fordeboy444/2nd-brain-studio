/**
 * Clipboard write that survives an `await` before it.
 *
 * Browsers tie `navigator.clipboard.writeText` to transient user activation, and
 * an async hop (e.g. an API call that MINTS the thing being copied) can outlive
 * it — the write then rejects even though the user really did click. The hidden
 * textarea + `execCommand("copy")` path is the fallback, and it is also what
 * runs under vitest, where jsdom has no clipboard API. Returns whether ANY path
 * succeeded; callers decide what to show when all fail.
 *
 * The reference app tried the native Tauri clipboard first, which has no
 * activation rule. This app is one web container with no native shell, so that
 * path is gone rather than stubbed.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but focusable; `readonly` stops the iOS-style keyboard flash.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
