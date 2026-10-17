import { useEffect, useState } from "react";
import { useStore } from "../store.js";

/**
 * The Browse screen: vault list + create form. The phase's first UI-to-API
 * interaction. Copy strings match the approved UI-SPEC verbatim.
 */
export function Browse() {
  const vaults = useStore((s) => s.vaults);
  const loading = useStore((s) => s.vaultsLoading);
  const error = useStore((s) => s.vaultsError);
  const loadVaults = useStore((s) => s.loadVaults);
  const createVault = useStore((s) => s.createVault);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    void loadVaults();
  }, [loadVaults]);

  const trimmed = name.trim();
  const canSubmit = trimmed !== "" && !creating;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createVault(trimmed);
      setName("");
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "1rem", fontFamily: "system-ui, sans-serif" }}>
      <h2>Vaults</h2>

      {loading ? (
        <p aria-busy="true">Loading…</p>
      ) : error ? (
        <p role="alert" style={{ color: "#b8473a" }}>
          Couldn't load your vaults. Try reloading the page.
        </p>
      ) : vaults.length === 0 ? (
        <div>
          <h3>No vaults yet</h3>
          <p>Create a vault to get started.</p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {vaults.map((v) => (
            <li key={v.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid #eee" }}>
              <strong>{v.name}</strong>
              <span style={{ color: "#888", marginLeft: "0.5rem" }}>
                {v.lastOpenedAt ? new Date(v.lastOpenedAt).toLocaleString() : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} style={{ marginTop: "1.5rem", display: "flex", gap: "0.5rem" }} aria-label="Create vault">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Vault name"
          aria-label="Vault name"
          style={{ flex: 1, padding: "0.4rem 0.6rem" }}
        />
        <button type="submit" disabled={!canSubmit} style={{ padding: "0.4rem 1rem" }}>
          {creating ? "Creating…" : "Create vault"}
        </button>
      </form>

      {createError ? (
        <p role="alert" style={{ color: "#b8473a", marginTop: "0.5rem" }}>
          {createError}
        </p>
      ) : null}
    </div>
  );
}