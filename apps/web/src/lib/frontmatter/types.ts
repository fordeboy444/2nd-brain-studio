/**
 * What a document's frontmatter is, this phase: text.
 *
 * There is no YAML parse here and that is deliberate (01-04-PLAN.md): the OKF
 * bundle's frontmatter is validated by the OKF library in Phase 2, and a second
 * YAML implementation living in the web client would be the one that disagrees
 * with it. Phase 1 reads the block and shows it.
 */
export interface Frontmatter {
  /**
   * The block's text with its fences removed — the raw YAML, untouched. `""`
   * when there is no block, so a caller never has to null-check the field.
   */
  raw: string;
  /** Whether the document opened with a delimited block at all. */
  present: boolean;
}
