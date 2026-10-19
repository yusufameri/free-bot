/**
 * The export's sprite icons (freebot-prototype.html:677-698), as nodes.
 *
 * The export builds these by string concatenation (`ic('x', 'ic-sm')` at `:746`); this app builds
 * them as SVG nodes. Only the symbols `apps/web/host/index.html` really carries can be drawn, so the
 * name is the sprite's own set rather than a free string.
 */

const SPRITE = ["x", "pin"] as const;

export type IconName = (typeof SPRITE)[number];

/** One `<svg class="ic …"><use href="#i-…"/></svg>`, the shape the export's `.ic` rules size. */
export function icon(name: IconName, size: "ic" | "ic-sm" = "ic-sm"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `ic ${size}`);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
