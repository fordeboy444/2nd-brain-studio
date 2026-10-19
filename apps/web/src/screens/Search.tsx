import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { toast } from "../lib/toast.js";
import { useStore } from "../store.js";

/* ------------------------------------------------------------------ */
/* Typing / helpers                                                   */
/* ------------------------------------------------------------------ */

interface SearchHit {
  file: string;
  line: number;
  snippet: string;
}

interface SearchResponse {
  groups?: Record<string, SearchHit[]>;
}

const GROUP_LABELS: Record<string, string> = {
  concept: "Concepts",
  concepts: "Concepts",
  summary: "Summaries",
  summaries: "Summaries",
  entity: "Entities",
  entities: "Entities",
  source: "Sources",
  sources: "Sources",
  other: "Other",
};

function groupLabel(key: string): string {
  const mapped = GROUP_LABELS[key.toLowerCase()];
  if (mapped) return mapped;
  const trimmed = key.trim();
  if (!trimmed) return "Other";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Safe highlight: text nodes only, never dangerouslySetInnerHTML. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  const lower = text.toLowerCase();
  while (true) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={`${idx}`}>{text.slice(idx, idx + needle.length)}</mark>);
    i = idx + needle.length;
  }
  return <>{parts}</>;
}

export function Search() {
  const currentVault = useStore((s) => s.currentVault);
  const vaultId = currentVault?.id ?? null;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, SearchHit[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!vaultId) return;
    const q = query.trim();
    if (!q) {
      setResults({});
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/vaults/${encodeURIComponent(vaultId)}/search?q=${encodeURIComponent(q)}`,
          );
          if (!res.ok) {
            throw new Error(`Search failed (${res.status}).`);
          }
          const data = (await res.json()) as SearchResponse;
          setResults(data.groups ?? {});
          setError(null);
        } catch (e) {
          setError((e as Error).message);
          toast((e as Error).message, "error");
        } finally {
          setLoading(false);
        }
      })();
    }, 200);

    return () => clearTimeout(timer);
  }, [query, vaultId]);

  function toggleGroup(key: string) {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function selectHit(hit: SearchHit) {
    const store = useStore.getState();
    if (vaultId) store.setSelectedFile(hit.file);
    store.setTargetLine(hit.line);
    store.requestReveal(hit.line);
    store.setActiveTab("browse");
    if (store.overlayOpen) store.closeOverlay();
  }

  const groupKeys = Object.keys(results);
  const totalHits = groupKeys.reduce((n, k) => n + (results[k]?.length ?? 0), 0);

  if (!vaultId) {
    return (
      <div className="search-screen" data-screen="search">
        <p className="search-empty">Open a vault to search its notes.</p>
      </div>
    );
  }

  return (
    <div className="search-screen" data-screen="search">
      <div className="search-toolbar">
        <input
          type="search"
          className="search-input"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          placeholder="Search vault…"
          aria-label="Search vault"
        />
        {loading && <span className="search-loading">Searching…</span>}
      </div>

      {error && <div className="search-error">{error}</div>}

      {!loading && query.trim() && totalHits === 0 && (
        <div className="search-empty">No matching notes found</div>
      )}

      {groupKeys.length === 0 && !query.trim() && (
        <div className="search-empty">Type to search your vault.</div>
      )}

      <div className="search-groups">
        {groupKeys.map((group) => {
          const hits = results[group] ?? [];
          const isCollapsed = collapsed[group] === true;
          return (
            <section key={group} className="search-group" data-group={group}>
              <button
                type="button"
                className="search-group__header"
                onClick={() => toggleGroup(group)}
                aria-expanded={!isCollapsed}
              >
                <span className="search-group__title">{groupLabel(group)}</span>
                <span className="search-group__count">{hits.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="search-group__hits">
                  {hits.map((hit, index) => (
                    <li key={`${hit.file}:${hit.line}:${index}`}>
                      <button
                        type="button"
                        className="search-hit"
                        onClick={() => selectHit(hit)}
                      >
                        <span className="search-hit__file">{hit.file}</span>
                        <span className="search-hit__line">:{hit.line}</span>
                        <span className="search-hit__snippet">
                          <Highlight text={hit.snippet} query={query} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {!loading && totalHits > 0 && (
        <div className="search-summary">{totalHits} result{totalHits === 1 ? "" : "s"}</div>
      )}
    </div>
  );
}
