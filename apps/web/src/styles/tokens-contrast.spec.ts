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

function luminance(hex: string): number {
  const raw = hex.slice(1);
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.slice(0, 6);
  return (
    0.2126 * channel(parseInt(full.slice(0, 2), 16)) +
    0.7152 * channel(parseInt(full.slice(2, 4), 16)) +
    0.0722 * channel(parseInt(full.slice(4, 6), 16))
  );
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = la > lb ? la : lb;
  const lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

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
