/**
 * The failure path, driven by fake data rather than by a wrecked page.
 *
 * Order 36's gate is only real if a chrome mismatch fails the build. These tests build the exact
 * report shapes the run produces, shift one number, and assert the failure list and the exit code
 * that would follow. No browser and no artifact is involved, so the proof cannot pass because a
 * screenshot happened to look right.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RegionDiff } from "./diff.ts";
import { boxFailures, chromeFailures, exitCodeFor, verdictFailures } from "./gate.ts";
import { LINUX_FLAGS, launchFlags } from "./page.ts";
import type { BoxDelta } from "./regions.ts";
import type { RegionReport, ViewportReport } from "./report.ts";

const ZERO: RegionDiff = {
  differing: 0,
  total: 100,
  share: 0,
  meanAbsolute: 0,
  maxChannel: 0,
  visible: 0,
};

const AGREE: BoxDelta = {
  agree: true,
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  detail: "app x,y,w,h 0,0,10,10 against export 0,0,10,10",
};

function region(over: Partial<RegionReport> & Pick<RegionReport, "id" | "kind">): RegionReport {
  const base: Omit<RegionReport, "id" | "kind"> = {
    status: "measured",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    variance:
      over.kind === "content" ? "a named reason this content region's sides may differ" : "",
    note: "a test region at index.html:1",
    boxDelta: AGREE,
    sourceBox: { left: 0, top: 0, width: 10, height: 10 },
    counterpartBox: { left: 0, top: 0, width: 10, height: 10 },
    stat: ZERO,
    crop: null,
  };
  return { ...base, ...over };
}

function report(regions: RegionReport[]): ViewportReport {
  return {
    index: 1,
    name: "wide",
    width: 1920,
    height: 1080,
    label: "09-wide-1920x1080",
    chrome: ZERO,
    content: ZERO,
    chromeRegions: regions.filter((entry) => entry.kind === "chrome").length,
    contentRegions: regions.filter((entry) => entry.kind === "content").length,
    whole: ZERO,
    regions,
    overflow: { document: [1920, 1920], regions: {}, overflowing: [] },
    digests: { app: "0000000000000000", export: "0000000000000000" },
    repeat: null,
    files: [],
  };
}

describe("the chrome verdict", () => {
  test("one differing chrome pixel fails the run by name", () => {
    const shifted = region({
      id: "chrome.aside-edge",
      kind: "chrome",
      stat: { ...ZERO, differing: 1, share: 0.01, maxChannel: 12 },
    });
    const failures = chromeFailures([report([shifted])]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("09-wide-1920x1080 chrome.aside-edge");
    expect(failures[0]).toContain("1 differing pixel(s) over a tolerance of 0");
    expect(exitCodeFor(failures)).toBe(1);
  });

  test("an absent chrome region is not a failure, because it has no statistic to read", () => {
    const absent = region({
      id: "chrome.aside-edge",
      kind: "chrome",
      status: "absent",
      rect: null,
      stat: null,
    });
    expect(chromeFailures([report([absent])])).toEqual([]);
    expect(exitCodeFor([])).toBe(0);
  });
});

describe("the box verdict", () => {
  test("a declared region that moved off its declared pixels fails", () => {
    const shifted = region({
      id: "content.center-composer",
      kind: "content",
      boxDelta: { ...AGREE, agree: false, top: 71.5, height: -71.5 },
    });
    const failures = boxFailures([report([shifted])]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("content.center-composer");
    expect(failures[0]).toContain("moved from the declared");
    expect(exitCodeFor(failures)).toBe(1);
  });

  test("a region with no declaration fails, per order 36's last sentence", () => {
    const undeclared = region({
      id: "content.center-header",
      kind: "content",
      boxDelta: { ...AGREE, agree: false, height: 62.43 },
    });
    const failures = boxFailures([report([undeclared])]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("is not declared in docs/DESIGN-CONTRACT.md");
  });

  test("a chrome box delta fails even when its pixels happen to match", () => {
    const shifted = region({
      id: "chrome.resizer",
      kind: "chrome",
      boxDelta: { ...AGREE, agree: false, left: 4 },
    });
    const failures = verdictFailures([report([shifted])]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("chrome box delta");
  });

  test("a report with every delta declared and every chrome pixel at zero exits 0", () => {
    const good = region({
      id: "content.center-composer",
      kind: "content",
      boxDelta: { ...AGREE, agree: false, top: 56.69, height: -56.68 },
    });
    const failures = verdictFailures([report([good])]);
    expect(failures).toEqual([]);
    expect(exitCodeFor(failures)).toBe(0);
  });

  test("a viewport that scrolls horizontally fails, by document or by region", () => {
    const base = report([]);
    const document = {
      ...base,
      overflow: { document: [1921, 1920] as const, regions: {}, overflowing: [] },
    };
    expect(verdictFailures([document])[0]).toContain("scrollWidth 1921 > window.innerWidth 1920");
    const regionOver = {
      ...base,
      overflow: { document: [1920, 1920] as const, regions: {}, overflowing: ["#thread"] },
    };
    expect(verdictFailures([regionOver])[0]).toContain("#thread has content wider than its box");
  });
});

describe("the browser flags", () => {
  test("the Mac build host gets the three determinism flags and no Linux flags", () => {
    expect(launchFlags("darwin")).toEqual([
      "--disable-lcd-text",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
    ]);
  });

  test("a Linux runner also gets the sandbox and shared-memory flags", () => {
    expect(launchFlags("linux")).toEqual(expect.arrayContaining([...LINUX_FLAGS]));
  });
});

describe("order 40's subject manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../verify/driver-subjects.json", import.meta.url), "utf8"),
  ) as { drivers: Array<{ id: string; command: string; artifact: string; subjects: string[] }> };

  test("names the pixel gate with the command and artifact this unit arms", () => {
    const entry = manifest.drivers.find((driver) => driver.id === "pixel-gate");
    expect(entry).toBeDefined();
    expect(entry?.command).toBe("bun packages/pixel-gate/src/cli.ts --repeat");
    expect(entry?.artifact).toBe("packages/verify/artifacts/pixel-gate");
  });

  test("names every file whose change invalidates the gate", () => {
    const entry = manifest.drivers.find((driver) => driver.id === "pixel-gate");
    for (const subject of [
      "apps/web/host/index.html",
      "apps/web/host/main.ts",
      "packages/ui/browser/**",
      "apps/server/src/api-server.ts",
      "design/prototype-84c6b185/freebot-prototype.html",
      "packages/pixel-gate/**",
    ]) {
      expect(entry?.subjects).toContain(subject);
    }
  });
});
