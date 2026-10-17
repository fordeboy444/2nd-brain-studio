import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* WCAG AA contrast contract for the text tokens.

   The Phase 01 UI verification measured two light-theme tokens below the 4.5:1
   floor for body text — `--text-tertiary` at 2.65:1 and `--accent` at 3.44:1 on
   the #faf9f8 canvas. Both were changed. A value in a stylesheet is easy to
   lower again by eye, and nothing else in the repo looks at it, so the numbers
   are computed here instead of trusted.

   The ratio is computed from the hex values themselves, per WCAG 2.x:
   channel -> linear, then 0.2126R + 0.7152G + 0.0722B, then (hi + 0.05) / (lo +
   0.05). 4.5:1 is the AA floor for text below 18.66px bold / 24px regular, and
   every one of these is body-sized or smaller.

   This runs in the node side of vitest; nothing here touches the DOM. */

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(HERE, "tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The body of the rule at `selector`. Comments are already gone, so a brace
 *  count is enough. */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start === -1) throw new Error(`tokens.css has no rule at ${selector}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

/** Every `--token: #hex` pair in a rule body. Non-hex values are skipped: this
 *  spec only has an opinion about literal colours. */
function hexTokens(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) out.set(name, value);
  }
  return out;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The three bytes of a `#rgb` or `#rrggbb` colour. */
function channels(hex: string): [number, number, number] {
  const raw = hex.slice(1);
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = la > lb ? la : lb;
  const lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

/** The hex a fill with alpha really paints. A transparent fill has no colour of
 *  its own: the layer beneath shows through it, and that composite is what the
 *  reader's eye receives and what this formula needs. Compositing is not a
 *  refinement here — the two themes differ by whether they even need it, and the
 *  dark tint is a plain hex while the light one is `rgba()`.
 *
 *  A fill that is already solid is returned unchanged, which is also the path
 *  for a token this function cannot parse. */
function painted(fill: string, under: string): string {
  const parts = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(fill);
  const red = parts?.[1];
  const green = parts?.[2];
  const blue = parts?.[3];
  if (red === undefined || green === undefined || blue === undefined) return fill;
  const alpha = parts?.[4] === undefined ? 1 : Number(parts[4]);
  const base = channels(under);
  const mixed = [Number(red), Number(green), Number(blue)].map((v, i) =>
    Math.round(v * alpha + (base[i] ?? 0) * (1 - alpha)),
  );
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** `rgba()` text for a hex at `alpha` — the input `painted` composites. */
function atAlpha(hex: string, alpha: number): string {
  return `rgba(${channels(hex).join(", ")}, ${alpha})`;
}

const AA = 4.5;
/** WCAG 1.4.11 non-text contrast: the floor for icons, glyphs and control
 *  boundaries. The two floors are not interchangeable, and the difference is
 *  not academic — `--text-tertiary` on the deep tint measures 3.88:1, which
 *  fails 4.5:1 and clears 3:1. It paints a chevron button, so 3:1 is the floor
 *  that applies. */
const AA_NON_TEXT = 3;

const LIGHT = hexTokens(ruleBody(css, ":root {"));
/** `[data-theme="dark"]` overrides `:root` rather than replacing it, so the two
 *  are merged — that is the cascade this app actually applies. */
const DARK = new Map([...LIGHT, ...hexTokens(ruleBody(css, '[data-theme="dark"] {'))]);

const THEMES: Array<[string, Map<string, string>]> = [
  ["light", LIGHT],
  ["dark", DARK],
];

/** The two surfaces body text is actually painted on. */
const SURFACES = ["--bg-app", "--bg-surface"];

/** The text tokens that carry prose. `--text-faint` is deliberately absent: it
 *  paints editor syntax markers and the fold chevrons, which are decorative and
 *  carry no information on their own. */
const PROSE_TOKENS = ["--text-primary", "--text-secondary", "--text-tertiary"];

function value(tokens: Map<string, string>, name: string): string {
  const hex = tokens.get(name);
  expect(hex, `${name} has no literal colour in this theme`).toBeDefined();
  return hex as string;
}

/* ── The tinted fills ─────────────────────────────────────────────────────────
   The two surfaces above are flat, and they are not where most of this app's
   text sits. The file tree paints body copy onto tinted fills as well, and a
   tint is not a value you can read off a token and compare: it carries alpha, so
   what the eye receives is the tint composited over the layer beneath it. That
   composite is the whole question, because the answer lands on both sides of the
   floor — `--text-secondary` measures 4.84:1 on the light `--bg-hover` and
   4.11:1 on the light `--accent-soft-hover`.

   These fills are resolved from the DECLARATIONS, not from `LIGHT`/`DARK`. Those
   two tables keep hex only, so the dark theme's `rgba()` tints are absent from
   them — and a lookup would then fall back to the light value that shares the
   name, which is a wrong answer that looks like a right one.

   `--text-tertiary` is the reason this section exists. The Phase 01 fix report
   exempted it as "unreachable", which was the right verdict on a wrong reason,
   and the wrong reason did not survive a check. The reason that does hold is
   below, and it is a statement about the stylesheet rather than about a value. */

/** Every `--token: value` pair in a rule body, value kept verbatim. Unlike
 *  `hexTokens` this keeps `rgba()`, `var()` and `color-mix()` — the three forms
 *  the tinted fills are written in. */
function declaredTokens(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(";")) {
    const at = part.indexOf(":");
    if (at === -1) continue;
    const name = part.slice(0, at).trim();
    const declared = part.slice(at + 1).trim();
    if (name.startsWith("--") && declared !== "") out.set(name, declared);
  }
  return out;
}

const LIGHT_DECL = declaredTokens(ruleBody(css, ":root {"));
/** `[data-theme="dark"]` overrides `:root` rather than replacing it, so the two
 *  are merged — the same cascade `DARK` follows. */
const DARK_DECL = new Map([...LIGHT_DECL, ...declaredTokens(ruleBody(css, '[data-theme="dark"] {'))]);

/** The colour a fill paints in one theme, resolved from how it is written:
 *  a hex is itself, an `rgba()` or a `color-mix` with transparent is composited
 *  over the surface it lies on, and `var(--x)` is whatever `--x` resolves to.
 *  A form this does not know throws rather than returning a string the contrast
 *  formula cannot use. */
function fillOf(name: string, decls: Map<string, string>): string {
  const declared = decls.get(name);
  if (declared === undefined) throw new Error(`${name} is not declared in this theme`);
  if (declared.startsWith("#")) return declared;

  const surface = fillOf("--bg-surface", decls);
  if (/^rgba?\(/.test(declared)) return painted(declared, surface);

  const mix = /^color-mix\(in srgb,\s*var\((--[A-Za-z0-9_-]+)\)\s+([\d.]+)%,\s*transparent\)$/.exec(
    declared,
  );
  const mixed = mix?.[1];
  if (mixed !== undefined) {
    return painted(atAlpha(fillOf(mixed, decls), Number(mix?.[2]) / 100), surface);
  }

  const alias = /^var\((--[A-Za-z0-9_-]+)\)$/.exec(declared);
  const target = alias?.[1];
  if (target !== undefined) return fillOf(target, decls);

  throw new Error(`${name} is written as "${declared}", which this spec cannot resolve`);
}

/** Each tinted pairing that App.css really paints, named so a failure says which
 *  rule to open. Read off the stylesheet, not guessed:
 *
 *    `.tree-row.selected` / `.tree-row.checked`      --text-primary on --accent-soft
 *    `.tree-row.selected:hover`                      --text-primary on --accent-soft-hover
 *    `.tree-more:hover` / `.backlinks-popover-count` --text-secondary on --bg-hover
 *    `.tree-row.selected .tree-glyph`                --accent on --accent-soft        (glyph)
 *    `.filetree-actions .tree-tool.on:hover`         --accent on --accent-soft-hover  (glyph)
 *    `.selbar-icon:active` / `.tree-tool:active`     --text-tertiary on --bg-active   (glyph)
 */
const TINTED_PAIRS: Array<[fill: string, text: string, floor: number]> = [
  ["--accent-soft", "--text-primary", AA],
  ["--accent-soft-hover", "--text-primary", AA],
  ["--bg-hover", "--text-secondary", AA],
  ["--accent-soft", "--accent", AA_NON_TEXT],
  ["--accent-soft-hover", "--accent", AA_NON_TEXT],
  ["--bg-active", "--text-tertiary", AA_NON_TEXT],
];

const FILLS = ["--accent-soft", "--accent-soft-hover", "--bg-hover", "--bg-active"];

/** `LIGHT`/`DARK` carry the prose tokens; `LIGHT_DECL`/`DARK_DECL` carry every
 *  declaration, which is what a tinted fill needs. Both are needed here. */
const TINT_THEMES: Array<[string, Map<string, string>, Map<string, string>]> = [
  ["light", LIGHT, LIGHT_DECL],
  ["dark", DARK, DARK_DECL],
];

describe("text on the tinted fills", () => {
  for (const [theme, tokens, decls] of TINT_THEMES) {
    it(`${theme}: every tinted fill resolves to a colour this spec can measure`, () => {
      // The four fills are written in four different forms across the two
      // themes. A resolver that returned the raw declaration would produce a NaN
      // ratio, and NaN fails every `>=` comparison — so this is the guard that
      // keeps a NaN from being read as a pass.
      for (const fill of FILLS) {
        const resolved = fillOf(fill, decls);
        expect(resolved, `${fill} resolved to "${resolved}"`).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    for (const [fill, text, floor] of TINTED_PAIRS) {
      it(`${theme}: ${text} on ${fill}`, () => {
        const ratio = contrast(value(tokens, text), fillOf(fill, decls));
        const criterion = floor === AA ? "AA text" : "1.4.11 non-text";
        expect(
          ratio,
          `${text} on ${fill} measures ${ratio.toFixed(2)}:1 against a ${floor}:1 floor (${criterion})`,
        ).toBeGreaterThanOrEqual(floor);
      });
    }

    it(`${theme}: --text-tertiary is never the colour of TEXT on a tinted fill`, () => {
      // The exemption, stated as a property of the stylesheet and not as a
      // number. `--text-tertiary` DOES paint on a tint — `.selbar-icon:active`
      // and `.tree-tool:active` put it on `--bg-active`, which is 3.88:1 in the
      // light theme. Both are icon buttons in a mouse-down state, so 1.4.11's
      // 3:1 governs and they pass. Every rule that pairs tertiary with a tint
      // must therefore be a glyph rule, and the two below are the only ones.
      const appCss = readFileSync(resolve(HERE, "App.css"), "utf8").replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
      const glyphRules = [".selbar-icon:active", ".tree-tool:active"];
      for (const selector of glyphRules) {
        expect(appCss, `${selector} is gone; re-check where tertiary paints on a tint`).toContain(
          selector,
        );
      }
      // And no rule sets tertiary copy on a tint fill in one body — that is the
      // shape `.tree-row.selected { background: …; color: var(--text-tertiary) }`
      // would take, and it would be a 4.5:1 failure rather than a 3:1 pass.
      const offenders: string[] = [];
      for (const match of appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = match[2] ?? "";
        const tinted =
          /background:\s*var\(--(bg-active|bg-hover|accent-soft|accent-soft-hover)\)/.test(body);
        if (tinted && /color:\s*var\(--text-tertiary\)/.test(body)) {
          offenders.push((match[1] ?? "").trim());
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${theme}: records the one tinted fill the reveal animation does not clear`, () => {
      // `@keyframes tree-reveal-unselected` brightens a freshly revealed row to
      // `--accent-soft-hover` at 30% while the row's own colour is still
      // `--text-secondary`. In the LIGHT theme that peak is 4.11:1 — below AA —
      // for part of a 900 ms animation, and `prefers-reduced-motion: reduce`
      // removes it entirely.
      //
      // Recorded, not tolerated in silence: the number is asserted, so a token
      // change that moved it either way would be reviewed rather than missed.
      const ratio = contrast(
        value(tokens, "--text-secondary"),
        fillOf("--accent-soft-hover", decls),
      );
      if (theme === "light") {
        expect(ratio, `the light reveal peak moved to ${ratio.toFixed(2)}:1 — re-decide it`).toBeLessThan(AA);
        expect(ratio, "the reveal peak got worse than the recorded 4.11:1").toBeGreaterThan(3.5);
      } else {
        expect(ratio, "the dark reveal peak now clears AA — drop the exception").toBeGreaterThanOrEqual(AA);
      }
      const appCss = readFileSync(resolve(HERE, "App.css"), "utf8");
      expect(appCss, "the reveal animation is gone; this exception is stale").toContain(
        "@keyframes tree-reveal-unselected",
      );
      expect(appCss, "reduced-motion no longer suppresses the reveal").toMatch(
        /prefers-reduced-motion[\s\S]{0,400}\.tree-row\.revealed\s*\{[^}]*animation:\s*none/,
      );
    });
  }
});

describe("text tokens clear WCAG AA", () => {
  for (const [theme, tokens] of THEMES) {
    for (const surface of SURFACES) {
      for (const token of PROSE_TOKENS) {
        it(`${theme}: ${token} on ${surface}`, () => {
          const ratio = contrast(value(tokens, token), value(tokens, surface));
          // The message carries the MEASURED number, because "it failed" is not
          // a finding anyone can act on, and the ratio is the whole finding.
          expect(ratio, `${token} on ${surface} measures ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
        });
      }
    }

    it(`${theme}: --accent is legible as text on both surfaces`, () => {
      for (const surface of SURFACES) {
        expect(contrast(value(tokens, "--accent"), value(tokens, surface))).toBeGreaterThanOrEqual(AA);
      }
    });

    it(`${theme}: --accent carries --text-on-accent`, () => {
      expect(
        contrast(value(tokens, "--text-on-accent"), value(tokens, "--accent")),
      ).toBeGreaterThanOrEqual(AA);
    });
  }
});
