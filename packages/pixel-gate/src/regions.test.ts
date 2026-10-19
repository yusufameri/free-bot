/**
 * The region map's own rules, over boxes the test writes rather than boxes a browser measured.
 *
 * Three claims are driven here, and each one is a claim the run's verdict depends on. A rectangle is
 * snapped outward to whole device pixels, so the denominator is a pixel count. A counterpart box is
 * compared on the same four numbers, so a structural difference becomes a literal delta. And a
 * region whose source box is not on screen is `absent` rather than a zero that reads as a pass.
 */

import { describe, expect, test } from "bun:test";
import {
  BOX_TOLERANCE,
  type Box,
  type BoxMap,
  CHROME_TOLERANCE_DEFAULT,
  REGIONS,
  type RegionSpec,
  resolveRegions,
  selectorsFor,
} from "./regions.ts";

const VIEWPORT = { name: "test", width: 100, height: 50 };

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height };
}

/** One spec and the two pages' boxes it needs, resolved at the test viewport. */
function resolve(spec: RegionSpec, app: BoxMap, exported: BoxMap) {
  const [region] = resolveRegions([spec], { app, export: exported }, VIEWPORT);
  if (region === undefined) throw new Error("no region resolved");
  return region;
}

const SPEC: RegionSpec = {
  id: "test.region",
  kind: "chrome",
  source: "export",
  selector: ".thing",
  counterpart: "#thing",
  edge: "box",
  size: 0,
  variance: "",
  note: "a test region",
};

describe("the map itself", () => {
  test("every region has a unique id", () => {
    const ids = REGIONS.map((region) => region.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every chrome region has an empty variance and every content region names one", () => {
    for (const region of REGIONS) {
      if (region.kind === "chrome") expect(region.variance).toBe("");
      else expect(region.variance.length).toBeGreaterThan(40);
    }
  });

  test("the map carries all four chrome regions and the thirteen content regions", () => {
    expect(REGIONS.filter((region) => region.kind === "chrome").length).toBe(4);
    expect(REGIONS.filter((region) => region.kind === "content").length).toBe(13);
  });

  test("every region's note names where its rectangle comes from", () => {
    for (const region of REGIONS) {
      expect(region.note).toMatch(
        /freebot-prototype\.html:|index\.html:|aside\.ts:|render\.ts:|overlays\.ts:|shell\.ts:/,
      );
    }
  });

  test("a chrome edge band has a thickness and a box region does not", () => {
    for (const region of REGIONS) {
      if (region.edge === "box") expect(region.size).toBe(0);
      else expect(region.size).toBeGreaterThan(0);
    }
  });

  test("the chrome tolerance is zero, per order 36b", () => {
    expect(CHROME_TOLERANCE_DEFAULT).toBe(0);
  });

  test("selectorsFor answers each page with the selectors that page carries", () => {
    expect(selectorsFor(REGIONS, "export")).toContain(".resizer");
    expect(selectorsFor(REGIONS, "export")).not.toContain("#resizer");
    expect(selectorsFor(REGIONS, "app")).toContain("#resizer");
    expect(selectorsFor(REGIONS, "app")).toContain("#aside .aside-tabs");
    expect(selectorsFor(REGIONS, "export")).toContain(".aside-tabs");
  });

  test("selectorsFor deduplicates, so a shared selector is measured once", () => {
    const list = selectorsFor(REGIONS, "app");
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("resolveRegions", () => {
  test("a whole box becomes its own rectangle, snapped to whole pixels", () => {
    const region = resolve(
      SPEC,
      { "#thing": box(10.4, 4.6, 30.2, 12.3) },
      { ".thing": box(10.4, 4.6, 30.2, 12.3) },
    );
    // floor(10.4)=10, ceil(10.4+30.2)=41 -> width 31; floor(4.6)=4, ceil(4.6+12.3)=17 -> height 13.
    expect(region.rect).toEqual({ x: 10, y: 4, width: 31, height: 13 });
    expect(region.status).toBe("measured");
  });

  test("an edge band is taken from the edge it names, and is that thick", () => {
    const left = resolve(
      { ...SPEC, edge: "left", size: 1 },
      { "#thing": box(20, 5, 30, 10) },
      { ".thing": box(20, 5, 30, 10) },
    );
    expect(left.rect).toEqual({ x: 20, y: 5, width: 1, height: 10 });
    const right = resolve(
      { ...SPEC, edge: "right", size: 1 },
      { "#thing": box(20, 5, 30, 10) },
      { ".thing": box(20, 5, 30, 10) },
    );
    expect(right.rect).toEqual({ x: 49, y: 5, width: 1, height: 10 });
    const bottom = resolve(
      { ...SPEC, edge: "bottom", size: 1 },
      { "#thing": box(20, 5, 30, 10) },
      { ".thing": box(20, 5, 30, 10) },
    );
    expect(bottom.rect).toEqual({ x: 20, y: 14, width: 30, height: 1 });
  });

  test("a region whose source box is absent is absent, not a zero", () => {
    const region = resolve(SPEC, { "#thing": box(0, 0, 10, 10) }, { ".thing": null });
    expect(region.rect).toBeNull();
    expect(region.status).toBe("absent");
  });

  test("a source box with no area is absent, so a hidden column cannot pass as a match", () => {
    const region = resolve(SPEC, { "#thing": box(0, 0, 10, 10) }, { ".thing": box(5, 5, 0, 30) });
    expect(region.rect).toBeNull();
    expect(region.status).toBe("absent");
  });

  test("a rectangle the viewport cuts is clipped and says so", () => {
    const region = resolve(
      SPEC,
      { "#thing": box(0, 0, 10, 10) },
      { ".thing": box(90, 40, 30, 30) },
    );
    expect(region.status).toBe("clipped");
    expect(region.rect).toEqual({ x: 90, y: 40, width: 10, height: 10 });
  });

  test("the rectangle is taken from the source side, and the delta names both sides", () => {
    const region = resolve(
      SPEC,
      { "#thing": box(50, 5, 20, 10) },
      { ".thing": box(20, 5, 20, 10) },
    );
    expect(region.rect).toEqual({ x: 20, y: 5, width: 20, height: 10 });
    expect(region.boxDelta?.left).toBe(30);
    expect(region.boxDelta?.width).toBe(0);
    expect(region.boxDelta?.agree).toBe(false);
  });

  test("boxes that agree within half a pixel are reported as agreeing", () => {
    const half = box(20 + BOX_TOLERANCE, 5, 20, 10);
    const region = resolve(SPEC, { "#thing": half }, { ".thing": box(20, 5, 20, 10) });
    expect(region.boxDelta?.agree).toBe(true);
    const over = box(20 + BOX_TOLERANCE + 0.01, 5, 20, 10);
    const disagreeing = resolve(SPEC, { "#thing": over }, { ".thing": box(20, 5, 20, 10) });
    expect(disagreeing.boxDelta?.agree).toBe(false);
  });

  test("a region with no counterpart box has no delta rather than a zero one", () => {
    const region = resolve(SPEC, { "#thing": null }, { ".thing": box(1, 1, 5, 5) });
    expect(region.counterpartBox).toBeNull();
    expect(region.boxDelta).toBeNull();
    // The source box is still there, because it is the export's own and the rectangle comes from it.
    expect(region.sourceBox).not.toBeNull();
    expect(region.rect).toEqual({ x: 1, y: 1, width: 5, height: 5 });
  });

  test("the delta's sign is app minus export whichever page the rectangle came from", () => {
    const fromExport = resolve(
      SPEC,
      { "#thing": box(30, 0, 10, 10) },
      { ".thing": box(10, 0, 10, 10) },
    );
    expect(fromExport.boxDelta?.left).toBe(20);
    const fromApp: RegionSpec = {
      ...SPEC,
      source: "app",
      selector: "#thing",
      counterpart: ".thing",
    };
    const same = resolve(
      fromApp,
      { "#thing": box(30, 0, 10, 10) },
      { ".thing": box(10, 0, 10, 10) },
    );
    expect(same.boxDelta?.left).toBe(20);
    // And the rectangle follows the source side, so the two are taken from different boxes.
    expect(fromExport.rect).toEqual({ x: 10, y: 0, width: 10, height: 10 });
    expect(same.rect).toEqual({ x: 30, y: 0, width: 10, height: 10 });
  });

  test("a content region reports its delta as well, because a box difference is a finding either way", () => {
    const region = resolve(
      { ...SPEC, kind: "content", variance: "a named reason for the difference between these two" },
      { "#thing": box(0, 0, 10, 10) },
      { ".thing": box(0, 12, 10, 10) },
    );
    expect(region.boxDelta?.top).toBe(-12);
    expect(region.boxDelta?.agree).toBe(false);
  });
});
