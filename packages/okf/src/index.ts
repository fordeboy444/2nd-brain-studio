/**
 * The `@2nd-brain/okf` public surface.
 *
 * Downstream phases import from here and never reach into `src/<module>.ts`.
 * Re-exports are explicit so this file stays a readable API list.
 */
export {
  FrontmatterError,
  parseFrontmatter,
  parseFrontmatterSafe,
  readIndexMeta,
  renderFrontmatter,
} from "./frontmatter.js";
export type {
  BundlePage,
  FrontmatterErrorCode,
  FrontmatterValue,
  IndexMeta,
  OkfFrontmatter,
} from "./frontmatter.js";

export { buildIndexes, compareCodepoint } from "./indexes.js";
export type {
  IndexBuildResult,
  IndexFile,
  Taxonomy,
  ThemeGroup,
} from "./indexes.js";

export {
  extractLinks,
  isExternalTarget,
  linkTarget,
  resolveBundlePath,
  stripCode,
} from "./links.js";

export { formatLintReport, lintBundle } from "./lint.js";
export type {
  LintFinding,
  LintOptions,
  LintResult,
  LintRule,
  LintSeverity,
} from "./lint.js";

export { slugify } from "./slug.js";
