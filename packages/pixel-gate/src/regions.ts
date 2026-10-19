/**
 * The region map: the one place a pixel-gate region is defined.
 *
 * Every region is one rectangle. The rectangle is measured from the box named by `source` and then
 * applied to both screenshots, which is the only way a pixel statistic has an attributable cause:
 * two rectangles taken separately from two differently laid out pages would differ for a reason the
 * number cannot express.
 *
 * A region is `chrome` or `content` (order 36b). Chrome is furniture the contract fixes: the
 * columns' separators and the resizer track. Its tolerance is zero differing pixels and every
 * non-zero pixel is a failure. Content is where real records are painted, so it is measured and
 * named rather than asserted: each content region carries the reason its two sides may differ, and
 * the report prints that reason beside the number.
 *
 * Every region also reports the counterpart box measured on the other page and the delta between the
 * two, whether or not it is chrome. That delta is how a structural difference between the pages
 * becomes a literal number instead of a paragraph, and it is what U6.7 needs first: a region whose
 * two boxes disagree is a region whose layout has not been reconciled, and the disagreement is
 * printed even when the pixels inside the chosen rectangle happen to match.
 *
 * Adding a region is adding one entry to `REGIONS`. Each entry's note names where its rectangle comes
 * from and why it is chrome or content. A region with no geometric counterpart on the other page is
 * not a region this map can carry, because its number would have no cause; those are named in
 * `docs/pixel-gate.md` instead.
 */

export type RegionKind = "chrome" | "content";

/** Which page the rectangle is measured on. The rectangle is then applied to both. */
export type RectSide = "app" | "export";

/** Which part of the source box the rectangle is: the whole box, or one edge band. */
export type RectEdge = "box" | "left" | "right" | "top" | "bottom";

export interface RegionSpec {
  readonly id: string;
  readonly kind: RegionKind;
  /** The page the rectangle is measured on. */
  readonly source: RectSide;
  /** The selector the rectangle is measured on, on `source`'s page. */
  readonly selector: string;
  /** The counterpart selector on the other page, measured so the two boxes can be compared. */
  readonly counterpart: string;
  readonly edge: RectEdge;
  /** The band's thickness in pixels. Ignored when `edge` is `box`. */
  readonly size: number;
  /** The named reason this region's two sides may differ. Empty for chrome. */
  readonly variance: string;
  /** Where the rectangle comes from, and why this region is chrome or content. */
  readonly note: string;
}

/** A one-pixel rule, the unit both stylesheets draw separators in. */
const RULE = 1;

export const REGIONS: readonly RegionSpec[] = [
  {
    id: "chrome.resizer",
    kind: "chrome",
    source: "export",
    selector: ".resizer",
    counterpart: "#resizer",
    edge: "box",
    size: 0,
    variance: "",
    note: "The 5px track between the thread column and the pane. Rectangle from the export's own DOM (freebot-prototype.html:673) at :387, measured against the app's `#resizer` (apps/web/host/index.html:822) at :85. Both paint it transparent at rest (the export's `.resizer::after` at :388 and the app's at :86 both start at opacity 0), so the rectangle shows only the page background and the contract requires zero differing pixels. A nonzero count is one side's track having moved or being painted. Absent at 1024px and below, where both stylesheets drop it (`freebot-prototype.html:542`, `index.html:108`).",
  },
  {
    id: "chrome.sidebar-edge",
    kind: "chrome",
    source: "export",
    selector: ".sidebar",
    counterpart: "#sidebar",
    edge: "right",
    size: RULE,
    variance: "",
    note: "The sidebar's `border-right`, a 1px band at the right edge of the sidebar column. Rectangle from the export's `.sidebar` box (:671) at :212 `border-right: 1px solid var(--border)`, against the app's `#sidebar` (:672) at :81 with the same declaration. Both draw the same token, so zero differing pixels is required. This band also pins the column's right edge, so a sidebar that widened or shifted fails here even though its width is measured elsewhere. Absent at 820px and below, where both stylesheets drop the column (`freebot-prototype.html:551`, `index.html:113`).",
  },
  {
    id: "chrome.aside-edge",
    kind: "chrome",
    source: "export",
    selector: ".aside",
    counterpart: "#aside",
    edge: "left",
    size: RULE,
    variance: "",
    note: "The pane's `border-left`, a 1px band at the left edge of the aside column. Rectangle from the export's `.aside` box (:674) at :390 `border-left: 1px solid var(--border)`, against the app's `#aside` (:823) at :93 with the same declaration. Zero differing pixels required. This band pins the pane's left edge, which is also where a resizer drag lands, so a drag default that moved shows up here. Absent at 1024px and below, where both stylesheets drop the pane (`freebot-prototype.html:542`, `index.html:108`).",
  },
  {
    id: "chrome.aside-strip-rule",
    kind: "chrome",
    source: "export",
    selector: ".aside-tabs",
    counterpart: "#aside .aside-tabs",
    edge: "bottom",
    size: RULE,
    variance: "",
    note: "The 1px rule under the pane's tab strip, taken as the bottom band of the export's `.aside-tabs` box (:1186) at :391 `border-bottom: 1px solid var(--border)`, against the app's own strip (#aside .aside-tabs, packages/ui/browser/aside.ts:120). The strip's contents differ by product, seven tabs against four, and those pixels are the content region below. This band is the strip's own height made visible: a strip that grew or shrank by a pixel moves this rule and fails here, while the tabs inside it are named variance rather than drift. Absent at 1024px and below with the pane.",
  },
  {
    id: "content.sidebar-list",
    kind: "content",
    source: "export",
    selector: "#sbList",
    counterpart: ".sb-scroll",
    edge: "box",
    size: 0,
    variance:
      "the export lists seven seeded prototype Bots under its Pinned, Primary, Unassigned and Hidden Bots headings, one of them mid-run with a pulsing status dot; this app lists the Bots its store really holds, which at this run's start is the one Bot the run created, and the thread list under them. Row count, row text and the list's own scroll extent differ by data.",
    note: "The sidebar's scrolling list. Rectangle from the export's own `#sbList` (:981, styled at :220) so the band is the contract's; the app's counterpart is its own scroll area `.sb-scroll` (index.html:675), which holds the Bot list and the thread list in the same band.",
  },
  {
    id: "content.center-header",
    kind: "content",
    source: "export",
    selector: ".chead",
    counterpart: "header",
    edge: "box",
    size: 0,
    variance:
      "the export's header is a Bot name with a status dot and a chevron, a role hint, a share control, a Computer button and a Details button; this app's is an `h1`, a one-line subtitle, the Bot title, a meta row and one Details control. Copy, control count and control order differ by product, and the app's own tab strip (Conversation, Library) sits directly under this band with no export counterpart.",
    note: "The thread column's header. Rectangle from the export's `.chead` (:1029, styled at :251, `min-height: 53px`), against the app's `header` (index.html:692, styled at :181). The two boxes are not expected to be the same height, so the box delta printed beside this region is a finding rather than a failure.",
  },
  {
    id: "content.center-transcript",
    kind: "content",
    source: "export",
    selector: "#transcript",
    counterpart: "#thread",
    edge: "box",
    size: 0,
    variance:
      "the export renders a seeded conversation with a run in progress, a tool call, a parked approval gate and an image attachment; this app renders the frames of the thread it really holds, which before a run is the idle note alone. Message text, message count and the band's own extent differ by data. The band's vertical start also differs by structure: the export's transcript begins under its 53px header, while this app's thread begins under its header, its tab strip and its composer row, so the box delta is expected to be large here until U6.7 reconciles the middle column's order.",
    note: "The conversation transcript. Rectangle from the export's own `#transcript` (:1063), against the app's `#thread` (index.html:814, styled at :220).",
  },
  {
    id: "content.center-composer",
    kind: "content",
    source: "export",
    selector: ".composer-wrap",
    counterpart: "#composer-wrap",
    edge: "box",
    size: 0,
    variance:
      "the export's composer is a growing textarea with attach, skills, mentions, dictate, voice, a conditional Stop now and a send button, pinned to the bottom of the column; this app's is a single-line text input, one Start run button and the live stream line, pinned to the same bottom edge. Control count, control labels and the band's own height differ by product; its top edge is the export's own padding once the bottom is pinned, so the height delta is the whole of the difference. The box delta beside this region is the literal size of that difference.",
    note: "The thread column's composer band. Rectangle from the export's `.composer-wrap` (:1070, styled at :364), against the app's `#composer-wrap` (index.html:905, styled at :208), which holds the form and the export's `.chint` place beside it.",
  },
  {
    id: "content.aside-strip",
    kind: "content",
    source: "export",
    selector: ".aside-tabs",
    counterpart: "#aside .aside-tabs",
    edge: "box",
    size: 0,
    variance:
      "the export's strip carries seven tabs (computer, details, memory, routines, tasks, library, media); this app carries the four with a real source (computer, details, tasks, library). Tab count, labels and the strip's own height differ by product, and docs/DESIGN-CONTRACT.md records both deltas. The 1px rule under the strip is the chrome region above, so this region is the tabs' own pixels.",
    note: "The pane's tab strip. Rectangle from the export's `.aside-tabs` (:1186), against the app's own strip mounted at packages/ui/browser/aside.ts:120.",
  },
  {
    id: "content.aside-body",
    kind: "content",
    source: "export",
    selector: "#asideBody",
    counterpart: "#asideBody",
    edge: "box",
    size: 0,
    variance:
      "the export's body is a mock computer panel with a screen, lifecycle and recovery blocks; this app's body reports the run, Bot, thread and provider records it really holds, and before any run it reports that it has none. Panel count, row count and the body's own scroll extent differ by data.",
    note: "The pane's scrolling body. Rectangle from the export's `#asideBody` (:1197), against the app's, which mounts the same id at packages/ui/browser/aside.ts:123.",
  },
  {
    id: "content.sidebar-bot-row",
    kind: "content",
    source: "app",
    selector: "#bot-list .sb-row",
    counterpart: "#sbList .sb-row",
    edge: "box",
    size: 0,
    variance:
      "the export's row carries a group, initials, a role and a state read from its seed; this app's carries the Bot's name, its run-derived sub line and the same state dot. Row count, the sub line's text and the dot's state differ by data, and the export's Pinned/Primary/Unassigned headings have no record in this app.",
    note: "The Bot row's own rectangle. Taken from the app's first `.sb-row` (packages/ui/browser/shell.ts:175, styled at index.html:124) against the export's `.sb-row` (freebot-prototype.html:962, styled at :227). The list's band is the region above; this one is the row the two pages both draw.",
  },
  {
    id: "content.item-turn-marker",
    kind: "content",
    source: "app",
    selector: ".tm",
    counterpart: ".tm",
    edge: "box",
    size: 0,
    variance:
      "the export paints its seeded turn's marker with a scripted sentence; this app's marker text is the live turn's phase (thinking, working, waiting), so the copy differs by the run and is absent before one starts. The 13.5px row, its 9px gap and its pulse are the export's.",
    note: "The turn marker. Taken from the app's `.tm` (packages/ui/browser/render.ts:281, styled at index.html:258) against the export's `.tm` (freebot-prototype.html:1104, styled at :310). Absent in the gate's idle shell, where no turn has started; the items driver measures the three phases under `packages/verify/artifacts/items/`.",
  },
  {
    id: "content.item-tool-card",
    kind: "content",
    source: "app",
    selector: ".tool-card",
    counterpart: ".tcard:not(.gate)",
    edge: "box",
    size: 0,
    variance:
      "the export's tool card is a seeded build with a two-match output disclosure; this app's is the command the live run made, with its own state word and its own output. Command text, line count and the disclosure's own extent differ by the run, and both are absent before one starts.",
    note: "The tool call's card. Taken from the app's `.tool-card` (packages/ui/browser/render.ts:300, styled at index.html:263) against the export's `.tcard:not(.gate)` (freebot-prototype.html:1106, styled at :312). Absent in the gate's idle shell; the items driver photographs it running, done, denied and failed.",
  },
  {
    id: "content.item-approval-card",
    kind: "content",
    source: "app",
    selector: ".approval-card",
    counterpart: ".tcard.gate",
    edge: "box",
    size: 0,
    variance:
      "the export's gate is seeded pending at 62 of 90 seconds with its own proposal and scope; this app's is the request the live run parked, carrying the command's own proposal and its real expiry. Copy, the bar's width and the resolved state differ by the run, and both are absent before one starts.",
    note: "The approval card. Taken from the app's `.approval-card` (packages/ui/browser/render.ts:369, styled at index.html:282) against the export's `.tcard.gate` (freebot-prototype.html:1116, styled at :354). Absent in the gate's idle shell; the items driver measures pending, allowed, denied and expired.",
  },
  {
    id: "content.overlay-palette",
    kind: "content",
    source: "app",
    selector: "#palette",
    counterpart: ".palette",
    edge: "box",
    size: 0,
    variance:
      "the export's palette lists settings, routines and quoted-message search; this app's lists Bots, threads, pages and actions, and its field and no-results copy say so. Row count, group names and text differ by product; the panel's measured width and top are the export's `min(600px, 100vw - 28px)` at `12vh`.",
    note: "The command palette's panel. Taken from the app's `#palette` (packages/ui/browser/overlays.ts:211, styled at index.html:492) against the export's `.palette` (freebot-prototype.html:2110, styled at :478). Absent in the gate's idle shell because no overlay is open; the overlays driver measures the open panel at every viewport.",
  },
  {
    id: "content.overlay-picker",
    kind: "content",
    source: "app",
    selector: "#picker",
    counterpart: ".picker",
    edge: "box",
    size: 0,
    variance:
      "the export's picker searches its seeded Bots and offers to name a new one; this app's searches the Bots its store holds and offers the same. Row count and text differ by data; the panel's geometry is the same `min(600px, 100vw - 28px)` panel.",
    note: "The Bot picker's panel. Taken from the app's `#picker` (packages/ui/browser/overlays.ts:314, styled at index.html:492) against the export's `.picker` (freebot-prototype.html:2091, styled at :478). Absent in the gate's idle shell; the overlays driver measures it open.",
  },
  {
    id: "content.overlay-modal",
    kind: "content",
    source: "app",
    selector: "#modal",
    counterpart: ".modal",
    edge: "box",
    size: 0,
    variance:
      "the export's modal ends with Download and Copy the path and scrolls its whole panel; this app's carries the name, path, size and bytes and scrolls the file box instead. Button count and the file's own height differ by product; the panel's `min(720px, 100vw - 32px)` width and `12vh` top are the export's.",
    note: "The file modal's panel. Taken from the app's `#modal` (packages/ui/browser/overlays.ts:400, styled at index.html:500) against the export's `.modal` (freebot-prototype.html:923, styled at :443). Absent in the gate's idle shell; the overlays driver measures the wide panel with a long file.",
  },
];

/** A box in viewport coordinates, as `getBoundingClientRect` reports it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type BoxMap = Readonly<Record<string, Box | null>>;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The four numbers two boxes are compared on, so a structural difference is a literal delta. */
export interface BoxDelta {
  readonly agree: boolean;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly detail: string;
}

export type RegionStatus = "measured" | "absent" | "clipped";

export interface ResolvedRegion {
  readonly id: string;
  readonly kind: RegionKind;
  readonly variance: string;
  readonly note: string;
  /** The rectangle both screenshots are compared inside, or null when the region is not on screen. */
  readonly rect: Rect | null;
  readonly status: RegionStatus;
  readonly sourceBox: Box | null;
  readonly counterpartBox: Box | null;
  /** How the two boxes compare, or null when there is no counterpart to compare with. */
  readonly boxDelta: BoxDelta | null;
}

export interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** The tolerance a box comparison uses: half a pixel of layout rounding, and no more. */
export const BOX_TOLERANCE = 0.5;

/**
 * A chrome region's tolerance, in differing pixels. Zero, per order 36b: the shell's tolerance is
 * near-zero by default and every non-zero pixel in a chrome region is a failure. It lives here
 * rather than in the run so U6.7 has one named place to calibrate it, and the report prints the
 * value it used beside every verdict.
 */
export const CHROME_TOLERANCE_DEFAULT = 0;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function rectangleFor(box: Box, edge: RectEdge, size: number): Rect {
  switch (edge) {
    case "box":
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    case "left":
      return { x: box.left, y: box.top, width: size, height: box.height };
    case "right":
      return { x: box.left + box.width - size, y: box.top, width: size, height: box.height };
    case "top":
      return { x: box.left, y: box.top, width: box.width, height: size };
    case "bottom":
      return { x: box.left, y: box.top + box.height - size, width: box.width, height: size };
  }
}

/**
 * A rectangle in device pixels, which is what a pixel diff can actually count.
 *
 * `getBoundingClientRect` reports fractional numbers and a pixel comparison counts whole pixels, so
 * every rectangle is snapped outward to the pixel grid: the left and top edges floor, the right and
 * bottom edges ceil. A rectangle that kept a fractional width would iterate a fractional number of
 * rows and report a denominator no pixel count could ever equal, which is the same defect as a
 * statistic with no denominator.
 */
function snap(box: Box, edge: RectEdge, size: number, viewport: Viewport): Rect | null {
  const raw = rectangleFor(box, edge, size);
  const x = Math.max(0, Math.floor(raw.x));
  const y = Math.max(0, Math.floor(raw.y));
  const right = Math.min(viewport.width, Math.ceil(raw.x + raw.width));
  const bottom = Math.min(viewport.height, Math.ceil(raw.y + raw.height));
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** True when a box's own rectangle is partly outside the viewport and had to be cut. */
function clipped(box: Box, edge: RectEdge, size: number, viewport: Viewport): boolean {
  const raw = rectangleFor(box, edge, size);
  return (
    raw.x < 0 ||
    raw.y < 0 ||
    raw.x + raw.width > viewport.width ||
    raw.y + raw.height > viewport.height
  );
}

/** The four numbers of a rectangle, in the order the delta is reported. */
function numbers(rect: Rect): readonly [number, number, number, number] {
  return [round(rect.x), round(rect.y), round(rect.width), round(rect.height)];
}

function present(box: Box | null | undefined): box is Box {
  return box !== null && box !== undefined && box.width > 0 && box.height > 0;
}

/**
 * How the app's rectangle and the export's differ, always as `app - export`.
 *
 * The sign is fixed at the app minus the export, not the source minus its counterpart, because a
 * reader has to be able to say which page moved without reading the map. A positive left is the
 * app's box further right than the export's.
 */
function deltaOf(
  app: Box | null,
  exported: Box | null,
  edge: RectEdge,
  size: number,
): BoxDelta | null {
  if (app === null || exported === null) return null;
  const mine = numbers(rectangleFor(app, edge, size));
  const theirs = numbers(rectangleFor(exported, edge, size));
  const d = mine.map((value, index) => round(value - (theirs[index] ?? 0)));
  const agree = d.every((value) => Math.abs(value) <= BOX_TOLERANCE);
  return {
    agree,
    left: d[0] ?? 0,
    top: d[1] ?? 0,
    width: d[2] ?? 0,
    height: d[3] ?? 0,
    detail: `app x,y,w,h ${mine.join(",")} against export ${theirs.join(",")}`,
  };
}

/**
 * Turn the map plus both pages' measured boxes into one rectangle per region.
 *
 * A region whose source box is missing or has no area is `absent`, which is the honest answer for a
 * column the breakpoints stand down: the aside and the resizer are not on screen at 1024px and
 * below, and the sidebar is not on screen at 820px and below. An absent region is not a pass and not
 * a failure. It is a region this viewport does not carry, and the report says so.
 */
export function resolveRegions(
  specs: readonly RegionSpec[],
  sides: { readonly app: BoxMap; readonly export: BoxMap },
  viewport: Viewport,
): ResolvedRegion[] {
  return specs.map((spec) => {
    const appBox = sides.app[spec.source === "app" ? spec.selector : spec.counterpart] ?? null;
    const exportBox =
      sides.export[spec.source === "app" ? spec.counterpart : spec.selector] ?? null;
    const sourceBox = spec.source === "app" ? appBox : exportBox;
    const counterpartBox = spec.source === "app" ? exportBox : appBox;
    const base = {
      id: spec.id,
      kind: spec.kind,
      variance: spec.variance,
      note: spec.note,
      sourceBox,
      counterpartBox,
    };
    const boxDelta = deltaOf(appBox, exportBox, spec.edge, spec.size);
    if (!present(sourceBox)) {
      return { ...base, rect: null, status: "absent" as const, boxDelta };
    }
    const rect = snap(sourceBox, spec.edge, spec.size, viewport);
    if (rect === null) {
      return { ...base, rect: null, status: "absent" as const, boxDelta };
    }
    return {
      ...base,
      rect,
      status: clipped(sourceBox, spec.edge, spec.size, viewport)
        ? ("clipped" as const)
        : ("measured" as const),
      boxDelta,
    };
  });
}

/** Every selector the map needs from one page, deduplicated, in map order. */
export function selectorsFor(specs: readonly RegionSpec[], side: RectSide): string[] {
  const out: string[] = [];
  for (const spec of specs) {
    const wanted = spec.source === side ? spec.selector : spec.counterpart;
    if (!out.includes(wanted)) out.push(wanted);
  }
  return out;
}
