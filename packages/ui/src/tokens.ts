/**
 * The frozen token table, extracted from the exported prototype and owned here.
 *
 * Order 32 makes the export the visual contract. `docs/DESIGN-CONTRACT.md` records which export
 * file governs which surface; the tokens below come from `freebot-prototype.html`'s `:root` block
 * (the file that carries the plan's token set, not the handoff's declared entry file, which carries
 * an older one), and every `source` names the line it was read from.
 *
 * This module is the only place a token value is written. `apps/web/host/index.html` and
 * `docs/DESIGN-CONTRACT.md` each carry a marked block that `bun packages/ui/scripts/emit-tokens.ts`
 * generates from here, and `tokens.test.ts` fails the build when either file drifts from it.
 *
 * Two origins appear in the table. `export` is a token the export writes in its own `:root`.
 * `derived` is a name this repo gives to a value the export writes literally inside a rule, which is
 * how the motion timings become nameable: the export has no motion custom properties, only
 * durations repeated across its transition and animation declarations. The harness compares the
 * `export` names against the export by name, and compares the motion by effect instead, on a paired
 * element's computed `transition-duration`.
 */

/** Where a token's value was read from the export. */
export type TokenOrigin = "export" | "derived";

export interface Token {
  /** The CSS custom property, including the leading dashes. */
  readonly name: string;
  /** The value, written exactly as the export writes it. */
  readonly value: string;
  /** The export and line the value is written on. */
  readonly source: string;
  readonly origin: TokenOrigin;
}

/** The export the tokens are read from, and one of the two files the contract reconciles. */
export const TOKEN_SOURCE = "freebot-prototype.html";

/** The values, in the order the export writes them. */
export const TOKENS: readonly Token[] = [
  // Colours. Six core values; every other colour in the system is a color-mix() of these.
  { name: "--bg", value: "#000000", source: `${TOKEN_SOURCE}:12`, origin: "export" },
  { name: "--surface", value: "#0a0a0a", source: `${TOKEN_SOURCE}:13`, origin: "export" },
  { name: "--fg", value: "#ffffff", source: `${TOKEN_SOURCE}:14`, origin: "export" },
  { name: "--muted", value: "#737373", source: `${TOKEN_SOURCE}:15`, origin: "export" },
  { name: "--border", value: "#242424", source: `${TOKEN_SOURCE}:16`, origin: "export" },
  { name: "--accent", value: "#000000", source: `${TOKEN_SOURCE}:17`, origin: "export" },
  { name: "--accent-2", value: "#0f172a", source: `${TOKEN_SOURCE}:18`, origin: "export" },
  // Derived fills: hover and soft washes, each a color-mix of the core six.
  {
    name: "--hover",
    value: "color-mix(in oklch, var(--fg) 7%, transparent)",
    source: `${TOKEN_SOURCE}:21`,
    origin: "export",
  },
  {
    name: "--hover-2",
    value: "color-mix(in oklch, var(--fg) 12%, transparent)",
    source: `${TOKEN_SOURCE}:22`,
    origin: "export",
  },
  {
    name: "--fg-soft",
    value: "color-mix(in oklch, var(--fg) 5%, transparent)",
    source: `${TOKEN_SOURCE}:23`,
    origin: "export",
  },
  {
    name: "--muted-2",
    value: "color-mix(in oklch, var(--muted) 45%, transparent)",
    source: `${TOKEN_SOURCE}:24`,
    origin: "export",
  },
  // Stacks. Display and body name the same family; the mono stack is the system's own.
  {
    name: "--font-display",
    value:
      "'Geist', 'Geist Sans', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    source: `${TOKEN_SOURCE}:26`,
    origin: "export",
  },
  {
    name: "--font-body",
    value:
      "'Geist', 'Geist Sans', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    source: `${TOKEN_SOURCE}:27`,
    origin: "export",
  },
  {
    name: "--font-mono",
    value: "ui-monospace, 'Geist Mono', 'SF Mono', Menlo, Consolas, monospace",
    source: `${TOKEN_SOURCE}:28`,
    origin: "export",
  },
  // Type scale. The h1 is fluid; the rest are fixed.
  {
    name: "--fs-h1",
    value: "clamp(30px, 4.4vw, 46px)",
    source: `${TOKEN_SOURCE}:30`,
    origin: "export",
  },
  { name: "--fs-h2", value: "24px", source: `${TOKEN_SOURCE}:31`, origin: "export" },
  { name: "--fs-h3", value: "17px", source: `${TOKEN_SOURCE}:32`, origin: "export" },
  { name: "--fs-body", value: "15px", source: `${TOKEN_SOURCE}:33`, origin: "export" },
  { name: "--fs-meta", value: "12.5px", source: `${TOKEN_SOURCE}:34`, origin: "export" },
  // Geometry.
  { name: "--radius", value: "8px", source: `${TOKEN_SOURCE}:36`, origin: "export" },
  { name: "--aside-w", value: "384px", source: `${TOKEN_SOURCE}:37`, origin: "export" },
  { name: "--sb-w", value: "264px", source: `${TOKEN_SOURCE}:38`, origin: "export" },
  // Motion: the export's own durations, named here because it names none of them.
  {
    name: "--dur-fast",
    value: "0.12s",
    source: `${TOKEN_SOURCE}:230 .sb-row { transition: background 0.12s ease }`,
    origin: "derived",
  },
  {
    name: "--dur",
    value: "0.15s",
    source: `${TOKEN_SOURCE}:120 .btn { transition: background 0.15s ease, ... }`,
    origin: "derived",
  },
  {
    name: "--dur-slow",
    value: "0.18s",
    source: `${TOKEN_SOURCE}:332 .disc .chev { transition: transform 0.18s ease }`,
    origin: "derived",
  },
  {
    name: "--dur-enter",
    value: "0.25s",
    source: `${TOKEN_SOURCE}:201 .flowline { animation: slide 0.25s ease }`,
    origin: "derived",
  },
  {
    name: "--dur-pulse",
    value: "1.5s",
    source: `${TOKEN_SOURCE}:110 .pulse { animation: pulse 1.5s ease-in-out infinite }`,
    origin: "derived",
  },
  {
    name: "--dur-spin",
    value: "1s",
    source: `${TOKEN_SOURCE}:112 .spin { animation: spin 1s linear infinite }`,
    origin: "derived",
  },
  {
    name: "--ease",
    value: "ease",
    source: `${TOKEN_SOURCE}:120 the easing keyword every transition writes`,
    origin: "derived",
  },
];

export function tokenValue(name: string): string {
  const found = TOKENS.find((token) => token.name === name);
  if (found === undefined) throw new Error(`no token named ${name}`);
  return found.value;
}

/** The marked region's opening line, in each file's own comment syntax. */
const BEGIN = {
  html: "/* tokens:begin",
  md: "<!-- tokens:begin",
} as const;

const BEGIN_NOTE =
  "Generated from packages/ui/src/tokens.ts by `bun packages/ui/scripts/emit-tokens.ts --write`.";

/** The marked region's closing line. */
const END_NOTE = "tokens:end";

/** One file that carries a generated token block, and how to write it. */
export interface TokenTarget {
  /** Repo-relative path. */
  readonly path: string;
  readonly syntax: keyof typeof BEGIN;
  /** The block's text, with no marker lines and no indentation of its own. */
  readonly body: () => string;
}

/** The declaration text: one token per line, as the export writes its `:root`. */
export function tokensCss(): string {
  const labels = TOKENS.map((token) => `${token.name}:`);
  const column = Math.max(...labels.map((label) => label.length)) + 1;
  const lines = TOKENS.map((token, i) => {
    const label = (labels[i] ?? "").padEnd(column);
    return `  ${label}${token.value};${originNote(token)}`;
  });
  return [":root {", ...lines, "}"].join("\n");
}

function originNote(token: Token): string {
  return token.origin === "derived" ? ` /* derived, see ${token.source} */` : "";
}

/** The same table as Markdown, for the contract document. */
export function tokensTable(): string {
  const rows = TOKENS.map(
    (token) => `| \`${token.name}\` | \`${token.value}\` | \`${token.source}\` |`,
  );
  return ["| Token | Value | Source |", "| --- | --- | --- |", ...rows].join("\n");
}

/** Every file whose marked block the emitter owns. */
export const HTML_TOKENS: TokenTarget = {
  path: "apps/web/host/index.html",
  syntax: "html",
  body: tokensCss,
};

/**
 * The landing route's own document (U6.6). It is a second page rather than a second token set: the
 * same `:root` block, written by the same emitter from this same table, so neither page can hold a
 * value the other does not.
 */
export const LANDING_TOKENS: TokenTarget = {
  path: "apps/web/landing/index.html",
  syntax: "html",
  body: tokensCss,
};

export const DOC_TOKENS: TokenTarget = {
  path: "docs/DESIGN-CONTRACT.md",
  syntax: "md",
  body: tokensTable,
};

export const TOKEN_TARGETS: readonly TokenTarget[] = [HTML_TOKENS, LANDING_TOKENS, DOC_TOKENS];

/**
 * Replace one target's marked block with the generated text, and nothing else. The block starts at
 * the line whose text begins with the begin marker, ends at the line that begins with the end
 * marker, and is rewritten with the same indentation the begin marker sits at.
 */
export function spliceTokens(target: TokenTarget, text: string): string {
  const lines = text.split("\n");
  const beginAt = lines.findIndex((line) => line.trimStart().startsWith(BEGIN[target.syntax]));
  const endAt = lines.findIndex((line) => line.includes(END_NOTE));
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    throw new Error(`${target.path}: no ${BEGIN[target.syntax]} ... ${END_NOTE} block`);
  }
  const head = lines[beginAt] ?? "";
  const indent = head.slice(0, head.indexOf(BEGIN[target.syntax]));
  const open =
    target.syntax === "md" ? `${BEGIN.md}. ${BEGIN_NOTE} -->` : `${BEGIN.html}. ${BEGIN_NOTE} */`;
  const close = target.syntax === "md" ? `<!-- ${END_NOTE} -->` : `/* ${END_NOTE} */`;
  const block = [
    indent + open,
    ...target
      .body()
      .split("\n")
      .map((line) => (line === "" ? "" : indent + line)),
    indent + close,
  ];
  return [...lines.slice(0, beginAt), ...block, ...lines.slice(endAt + 1)].join("\n");
}
