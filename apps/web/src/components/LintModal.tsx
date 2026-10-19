import { type CSSProperties } from "react";
import type { LintFinding, LintReport } from "../lib/api.js";

/** Re-exported so the spec can import the report type from the modal's own
 *  module surface rather than reaching past it to `lib/api.js`. */
export type { LintReport };

/**
 * The lint report modal (API-01, API-02, T-05-12).
 *
 * `GET /api/vaults/:id/lint` returns `{ ok, errors, warnings, scanned }` where
 * each finding is `{ rule, severity, message }` — the message embeds the file
 * path (e.g. `E2 broken link \`x.md\` in concepts/beta.md`). This modal turns
 * the structured report into a scannable summary: a pass/fail header, count
 * badges, and a scrollable list of issues where each row's file path is
 * extracted from the message and rendered as a click-through link.
 *
 * T-05-12 (DoS via a huge lint list) is mitigated by the list container's
 * `max-height` + `overflow-y: auto`: a bundle with 200 broken links renders
 * 200 rows inside a bounded scroll area, not a modal that grows past the
 * viewport and freezes the page.
 */

/** Extract the last `.md` path from a lint message. The OKF lint rules format
 *  messages as `E2 broken link \`missing.md\` in concepts/beta.md` — the file
 *  WITH the issue is the last path (`concepts/beta.md`), not the broken target
 *  (`missing.md`). Returns `null` when the message has no `.md` path. */
export function extractFilePath(message: string): string | null {
  const matches = message.match(/[\w/.-]+\.md/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1]!;
}

export interface LintModalProps {
  report: LintReport;
  /** Click handler for a file link. Receives the vault-relative path. */
  onSelectFile: (path: string) => void;
  /** Close handler. */
  onClose: () => void;
}

export function LintModal({ report, onSelectFile, onClose }: LintModalProps) {
  const errors = report.errors;
  const warnings = report.warnings;
  const allIssues: LintFinding[] = [...errors, ...warnings];

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        // Click on the backdrop (not the dialog) closes the modal.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        data-lint-modal
        className="lint-modal"
        role="dialog"
        aria-label="Lint report"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          width: "min(640px, 90vw)",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--sp-4) var(--sp-5)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "var(--fs-lg)", color: "var(--text-primary)" }}>
            Lint Report
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="icon-btn"
            style={{
              border: 0,
              background: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "var(--fs-xl)",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </header>

        <div style={{ padding: "var(--sp-4) var(--sp-5)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
            <span
              style={{
                fontWeight: 700,
                fontSize: "var(--fs-md)",
                color: report.ok ? "var(--success)" : "var(--danger)",
              }}
            >
              {report.ok ? "Passed" : "Failed"}
            </span>
            <span style={{ color: "var(--text-tertiary)", fontSize: "var(--fs-sm)" }}>
              {report.scanned} files scanned
            </span>
            {errors.length > 0 && (
              <span
                style={{
                  padding: "var(--sp-1) var(--sp-3)",
                  borderRadius: "var(--radius-pill)",
                  background: "var(--danger-soft, rgba(220, 38, 38, 0.12))",
                  color: "var(--danger)",
                  fontSize: "var(--fs-sm)",
                  fontWeight: 600,
                }}
              >
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </span>
            )}
            {warnings.length > 0 && (
              <span
                style={{
                  padding: "var(--sp-1) var(--sp-3)",
                  borderRadius: "var(--radius-pill)",
                  background: "var(--warning-soft, rgba(217, 119, 6, 0.12))",
                  color: "var(--warning)",
                  fontSize: "var(--fs-sm)",
                  fontWeight: 600,
                }}
              >
                {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
              </span>
            )}
          </div>
        </div>

        <div
          data-lint-list
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            maxHeight: "400px",
            padding: "var(--sp-2) 0",
          }}
        >
          {allIssues.length === 0 ? (
            <p
              style={{
                padding: "var(--sp-5)",
                margin: 0,
                color: "var(--text-secondary)",
                textAlign: "center",
              }}
            >
              No issues found. The bundle is lint-clean.
            </p>
          ) : (
            allIssues.map((finding, i) => {
              const filePath = extractFilePath(finding.message);
              return (
                <div
                  key={`${finding.rule}-${i}`}
                  data-lint-issue
                  data-rule={finding.rule}
                  data-severity={finding.severity}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "var(--sp-3)",
                    padding: "var(--sp-2) var(--sp-5)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span
                    style={{
                      flex: "none",
                      padding: "2px var(--sp-2)",
                      borderRadius: "var(--radius-sm)",
                      fontSize: "var(--fs-xs)",
                      fontWeight: 700,
                      fontFamily: "var(--font-mono, monospace)",
                      background:
                        finding.severity === "error"
                          ? "var(--danger-soft, rgba(220, 38, 38, 0.12))"
                          : "var(--warning-soft, rgba(217, 119, 6, 0.12))",
                      color: finding.severity === "error" ? "var(--danger)" : "var(--warning)",
                    }}
                  >
                    {finding.rule}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: "var(--fs-sm)",
                      color: "var(--text-primary)",
                      lineHeight: 1.5,
                      wordBreak: "break-word",
                    }}
                  >
                    {finding.message}
                  </span>
                  {filePath ? (
                    <button
                      type="button"
                      data-lint-file-link
                      data-path={filePath}
                      onClick={() => {
                        onSelectFile(filePath);
                        onClose();
                      }}
                      style={{
                        flex: "none",
                        padding: "2px var(--sp-2)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--bg-elevated)",
                        color: "var(--accent)",
                        fontSize: "var(--fs-xs)",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Open
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}