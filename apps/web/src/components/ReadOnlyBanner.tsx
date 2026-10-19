import { useStore } from "../store.js";

/**
 * Persistent banner shown when this container is the secondary, read-only
 * instance (OPS-06). Mirrors `/api/health`'s `readOnly` flag — UI-only truth,
 * enforced authoritatively by the server middleware.
 */
export function ReadOnlyBanner() {
  const isReadOnly = useStore((s) => s.isReadOnly);

  if (!isReadOnly) return null;

  return (
    <div
      className="read-only-banner global-banner"
      role="status"
      aria-live="polite"
      data-read-only="true"
    >
      <span aria-hidden="true" className="read-only-banner__icon">🔒</span>
      <span>
        Read-Only Mode — Another instance is active. Mutations are disabled.
      </span>
      <span className="read-only-banner__detail">
        This instance is read-only — another instance holds the write lock.
      </span>
    </div>
  );
}