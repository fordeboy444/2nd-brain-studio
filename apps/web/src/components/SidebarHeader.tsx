import { useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import { copyText } from "../lib/clipboard.js";
import { toast } from "../lib/toast.js";

/**
 * The top of the sidebar: which vault is open, and where on disk it lives.
 *
 * Two controls, both of them real:
 * - The name opens the vault switcher. This app's switcher is the vault list on
 *   the Browse screen, so the name (and the chevron beside it) returns to it —
 *   the same gesture the reference's name button makes.
 * - The path copies itself. Folder paths get pasted into terminals and issue
 *   reports constantly, and a path you can click beats one you have to retype.
 *
 * PORTED NOTE: the reference's header opened a hover popover of vaults, carried
 * a sync-switch spinner, an org name/logo for synced vaults and a `motion`
 * cross-fade between names. None of that has a counterpart here — there is one
 * local vault folder and no account layer — so the switcher popover, the
 * spinner, the org name and the motion are gone. The classes, the layout and
 * the copy-path behaviour are the reference's.
 */
export function SidebarHeader() {
  const vault = useStore((s) => s.currentVault);
  const closeVault = useStore((s) => s.closeVault);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  // No vault open: the screen is the vault list, and this header has nothing to
  // say about a vault. The reference does the same thing for a missing vault.
  if (!vault) return null;

  const copyPath = async () => {
    if (await copyText(vault.path)) {
      setCopiedPath(vault.path);
      // The tick is an acknowledgement, not a state: it goes away on its own.
      window.setTimeout(() => setCopiedPath((p) => (p === vault.path ? null : p)), 1800);
    } else {
      toast("Couldn't copy the vault path", "error");
    }
  };

  return (
    <div className="sidebar-header">
      <div className="sidebar-header-id">
        <span className="vault-switch-tile">
          <VaultTile name={vault.name} />
        </span>
        <div className="sidebar-header-text">
          <div className="sidebar-header-main">
            <button
              type="button"
              className="vault-switch-btn"
              title="Switch vault"
              onClick={closeVault}
            >
              <span className="vault-name" title={vault.name}>
                {vault.name}
              </span>
              <svg
                className="vault-switch-chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>
          <div className="vault-line" title={vault.path}>
            <span
              className="vault-path-copy"
              role="button"
              tabIndex={0}
              title={`Copy ${vault.path}`}
              aria-label="Copy vault folder path"
              onClick={() => void copyPath()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void copyPath();
                }
              }}
            >
              <span className="vault-path">{vault.path}</span>
              {copiedPath === vault.path && (
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="vault-path-copied"
                  role="img"
                  aria-label="Path copied"
                >
                  <path d="m3 8 3 3 7-7" />
                </svg>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Four tile fills drawn from the theme's own soft/strong pairs, so the tile
 *  reads correctly in both themes without a colour table of its own. */
const TILE_FILLS = [
  { fill: "var(--accent-soft)", ink: "var(--accent)" },
  { fill: "var(--success-soft)", ink: "var(--success)" },
  { fill: "var(--warning-soft)", ink: "var(--warning)" },
  { fill: "var(--danger-soft)", ink: "var(--danger)" },
] as const;

/**
 * A vault's tile: its initial on a fill picked from the vault's identity.
 *
 * PORTED NOTE: the reference resolved an uploaded image, then a per-device
 * preset, then a generated default — all of it account-layer state (org logos,
 * `readLocalVaultIcon`, an on-disk icon store) that this app does not have. The
 * fallback shape is the reference's own: a coloured tile carrying a glyph.
 */
function VaultTile({ name }: { name: string }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  // Deterministic on the name, so a vault keeps its colour across reloads and
  // across the header, the switcher and settings.
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 4096;
  const color = TILE_FILLS[hash % TILE_FILLS.length] ?? TILE_FILLS[0];
  return (
    <span
      className="vault-tile"
      style={{ "--tile-fill": color.fill, "--tile-ink": color.ink } as CSSProperties}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
