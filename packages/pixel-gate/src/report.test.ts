/**
 * The report's arithmetic and the two-run proof, over reports the test writes.
 *
 * `sumDiffs` is what makes a viewport's headline chrome number, so it is driven on the case that
 * would hide a regression: regions of different sizes, where a mean of means disagrees with the true
 * mean over the pixels. `compareRuns` is the two-run proof as a function, so a stability claim is a
 * command a reviewer can rerun rather than a paragraph a reader has to trust.
 */

import { describe, expect, test } from "bun:test";
import type { RegionDiff } from "./diff.ts";
import {
  canonicalJson,
  compareRuns,
  type RegionReport,
  type RunReport,
  renderJson,
  renderText,
  sumDiffs,
  type ViewportReport,
} from "./report.ts";

function diff(differing: number, total: number, meanAbsolute = 1, maxChannel = 1): RegionDiff {
  return {
    differing,
    total,
    share: total === 0 ? 0 : differing / total,
    meanAbsolute,
    maxChannel,
    visible: differing,
  };
}

function region(
  id: string,
  kind: "chrome" | "content",
  stat: RegionDiff | null,
  status: RegionReport["status"] = "measured",
): RegionReport {
  return {
    id,
    kind,
    status,
    rect: stat === null ? null : { x: 0, y: 0, width: 2, height: 2 },
    variance: kind === "content" ? "a named reason" : "",
    note: "a test region",
    boxDelta: {
      agree: true,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      detail: "app x,y,w,h 0,0,2,2 against export 0,0,2,2",
    },
    sourceBox: { left: 0, top: 0, width: 2, height: 2 },
    counterpartBox: { left: 0, top: 0, width: 2, height: 2 },
    stat,
    crop: null,
  };
}

function viewport(label: string, regions: readonly RegionReport[]): ViewportReport {
  return {
    index: 1,
    name: label,
    width: 2,
    height: 2,
    label,
    chrome: sumDiffs(
      regions
        .filter((r) => r.kind === "chrome" && r.stat !== null)
        .map((r) => r.stat as RegionDiff),
    ),
    content: sumDiffs(
      regions
        .filter((r) => r.kind === "content" && r.stat !== null)
        .map((r) => r.stat as RegionDiff),
    ),
    chromeRegions: regions.filter((r) => r.kind === "chrome" && r.status === "measured").length,
    contentRegions: regions.filter((r) => r.kind === "content" && r.status === "measured").length,
    whole: diff(0, 4),
    regions,
    overflow: { document: [2, 2], regions: {}, overflowing: [] },
    digests: { app: "aaaaaaaaaaaaaaaa", export: "bbbbbbbbbbbbbbbb" },
    repeat: null,
    files: [],
  };
}

function run(viewports: readonly ViewportReport[], failures: readonly string[] = []): RunReport {
  return {
    feature: "pixel-gate",
    command: "bun packages/pixel-gate/src/cli.ts",
    commit: "0".repeat(40),
    shortSha: "0000000",
    branch: "test",
    dirty: false,
    startedAt: "2026-10-18T00:00:00.000Z",
    runtime: "bun test",
    chrome: "chrome test",
    fonts: {
      appStack: "Geist, sans-serif",
      exportStack: "Geist, sans-serif",
      same: true,
      appGeistWidth: 10,
      appAbsentWidth: 10,
      exportGeistWidth: 10,
      exportAbsentWidth: 10,
      geistResolves: false,
    },
    app: {
      home: "/tmp/home",
      url: "http://127.0.0.1:1/#token=<redacted>",
      botId: "bot-local",
      threadId: "thread-1",
      provider: "replay",
      vault: "/tmp/home/provider.env",
    },
    exportSource: {
      file: "design/prototype-84c6b185/freebot-prototype.html",
      initialScreenReplacements: 1,
      servedAt: "http://127.0.0.1:2/",
    },
    viewports,
    chromeTolerance: 0,
    repeatRequested: false,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    failures,
  };
}

describe("sumDiffs", () => {
  test("no regions sum to a zero statistic, not to an undefined share", () => {
    const total = sumDiffs([]);
    expect(total).toEqual({
      differing: 0,
      total: 0,
      share: 0,
      meanAbsolute: 0,
      maxChannel: 0,
      visible: 0,
    });
  });

  test("the differing counts and the totals add", () => {
    const total = sumDiffs([diff(1, 100), diff(2, 300)]);
    expect(total.differing).toBe(3);
    expect(total.total).toBe(400);
    expect(total.share).toBeCloseTo(3 / 400, 12);
  });

  test("the mean is over the pixels, not the mean of the regions' means", () => {
    // A big region that matches and a small one that differs wildly. A mean of means would report
    // 50; the true mean over 400 pixels is 0.25.
    const total = sumDiffs([diff(0, 399, 0), diff(1, 1, 100)]);
    expect(total.meanAbsolute).toBeCloseTo((1 * 100) / 400, 12);
  });

  test("the max channel is the worst region's, not an average", () => {
    expect(sumDiffs([diff(1, 1, 0, 3), diff(1, 1, 0, 200)]).maxChannel).toBe(200);
  });

  test("the visible count adds across regions", () => {
    expect(sumDiffs([diff(5, 10), diff(7, 10)]).visible).toBe(12);
  });
});

describe("canonicalJson", () => {
  test("a short array of numbers stays on one line, as the repo's formatter prints it", () => {
    expect(canonicalJson({ a: [360, 360] })).toBe('{\n  "a": [360, 360]\n}');
  });

  test("an array too wide for the budget expands with its elements indented one level deeper", () => {
    // The nested array's own indent is the parent key's indent plus two spaces, not the flat ones.
    const text = canonicalJson({ long: ["a".repeat(80), "b".repeat(40)] });
    expect(text).toBe(`{\n  "long": [\n    "${"a".repeat(80)}",\n    "${"b".repeat(40)}"\n  ]\n}`);
  });

  test("an array of objects always expands, because an object is never inline", () => {
    const text = canonicalJson({ e: [{ f: 1 }, { g: 2 }] });
    expect(text).toBe(
      '{\n  "e": [\n    {\n      "f": 1\n    },\n    {\n      "g": 2\n    }\n  ]\n}',
    );
  });

  test("an array nested inside a nested object stays flat while it fits the budget", () => {
    const text = canonicalJson({
      nested: {
        deep: {
          arr: [
            [1, 2],
            [3, 4],
          ],
        },
      },
    });
    expect(text).toBe(
      '{\n  "nested": {\n    "deep": {\n      "arr": [[1, 2], [3, 4]]\n    }\n  }\n}',
    );
  });

  test("an array of arrays that overflows expands with each inner array still flat", () => {
    const text = canonicalJson({
      wide: [
        [1, 2, 3],
        ["a".repeat(90), "b"],
      ],
    });
    expect(text).toBe(
      `{\n  "wide": [\n    [1, 2, 3],\n    [\n      "${"a".repeat(90)}",\n      "b"\n    ]\n  ]\n}`,
    );
  });

  test("empty containers, null and booleans print without crashing", () => {
    expect(canonicalJson({ empty: [], emptyObj: {}, nullish: null, t: true, n: 1.5 })).toBe(
      '{\n  "empty": [],\n  "emptyObj": {},\n  "nullish": null,\n  "t": true,\n  "n": 1.5\n}',
    );
  });

  test("a mixed array expands, its scalar members beside an object and a flat array", () => {
    const text = canonicalJson({ mixed: [1, "two", { three: 3 }, [4, 5]] });
    expect(text).toBe(
      '{\n  "mixed": [\n    1,\n    "two",\n    {\n      "three": 3\n    },\n    [4, 5]\n  ]\n}',
    );
  });

  test("the whole summary round-trips, so formatting never loses a number", () => {
    const summary = JSON.parse(
      renderJson(run([viewport("01", [region("chrome.x", "chrome", diff(0, 100))])])),
    ) as unknown;
    expect(JSON.parse(canonicalJson(summary))).toEqual(summary);
  });

  test("a long key's array expands even when the array's own text is short", () => {
    // Biome's budget is the whole line, so the key and its colon count. The run's `files` array is
    // this case: two short names under an eight-space key, which fits the budget on its own and does
    // not fit the line. Getting this wrong was the one lint error the first baseline artifact made.
    const text = canonicalJson({
      viewport: {
        files: [
          "04-foldable-small-tablet-600x960.app.png",
          "04-foldable-small-tablet-600x960.export.png",
        ],
      },
    });
    expect(text).toContain('"files": [\n      "04-foldable-small-tablet-600x960.app.png",');
    // The same two names under a short key stay on one line.
    const short = canonicalJson({ f: ["a.png", "b.png"] });
    expect(short).toContain('"f": ["a.png", "b.png"]');
  });

  test("an undefined property is dropped rather than printed as null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{\n  "a": 1\n}');
  });
});

describe("compareRuns", () => {
  test("two runs whose chrome counts are equal are stable at epsilon 0", () => {
    const a = run([viewport("01", [region("chrome.x", "chrome", diff(0, 100))])]);
    const b = run([viewport("01", [region("chrome.x", "chrome", diff(0, 100))])]);
    const proof = compareRuns(a, b, 0);
    expect(proof.same).toBe(true);
    expect(proof.lines.some((line) => line.startsWith("ok  "))).toBe(true);
    expect(proof.lines.some((line) => line.startsWith("FAIL"))).toBe(false);
  });

  test("a chrome count that moved by one pixel is unstable at epsilon 0", () => {
    const a = run([viewport("01", [region("chrome.x", "chrome", diff(0, 100))])]);
    const b = run([viewport("01", [region("chrome.x", "chrome", diff(1, 100))])]);
    const proof = compareRuns(a, b, 0);
    expect(proof.same).toBe(false);
    expect(proof.lines.some((line) => line.startsWith("FAIL"))).toBe(true);
  });

  test("a stated epsilon admits the movement it names and no more", () => {
    const a = run([viewport("01", [region("chrome.x", "chrome", diff(0, 100))])]);
    const b = run([viewport("01", [region("chrome.x", "chrome", diff(2, 100))])]);
    expect(compareRuns(a, b, 2).same).toBe(true);
    expect(compareRuns(a, b, 1).same).toBe(false);
  });

  test("a viewport present in one run and absent from the other is unstable", () => {
    const a = run([viewport("01", [region("chrome.x", "chrome", diff(0, 100))])]);
    const b = run([]);
    expect(compareRuns(a, b, 0).same).toBe(false);
  });

  test("a region measured in one run and absent in the other is unstable", () => {
    const a = run([viewport("01", [region("chrome.x", "chrome", diff(0, 100))])]);
    const b = run([viewport("01", [region("chrome.x", "chrome", null, "absent")])]);
    expect(compareRuns(a, b, 0).same).toBe(false);
  });

  test("a region absent in both runs is not a stability failure", () => {
    const a = run([viewport("01", [region("chrome.x", "chrome", null, "absent")])]);
    const b = run([viewport("01", [region("chrome.x", "chrome", null, "absent")])]);
    expect(compareRuns(a, b, 0).same).toBe(true);
  });

  test("content regions are not part of the chrome proof", () => {
    const a = run([viewport("01", [region("content.x", "content", diff(0, 100))])]);
    const b = run([viewport("01", [region("content.x", "content", diff(50, 100))])]);
    expect(compareRuns(a, b, 0).same).toBe(true);
  });
});

describe("renderText", () => {
  test("names the command, the commit and both regions' numbers", () => {
    const text = renderText(
      run([
        viewport("01-wide-1920x1080", [
          region("chrome.resizer", "chrome", diff(0, 5400)),
          region("content.aside-body", "content", diff(10, 100)),
        ]),
      ]),
    );
    expect(text).toContain("bun packages/pixel-gate/src/cli.ts");
    expect(text).toContain("chrome.resizer");
    expect(text).toContain("0/5400 pixels differ");
    expect(text).toContain("named variance:");
    expect(text).toContain("RESULT: PASS");
    expect(text).toContain("every chrome region this run carried is within tolerance");
  });

  test("an absent region is printed as absent, not as a zero that reads as a match", () => {
    const text = renderText(
      run([viewport("01", [region("chrome.aside-edge", "chrome", null, "absent")])]),
    );
    expect(text).toContain("the region is not on this viewport");
    expect(text).not.toMatch(/chrome\.aside-edge\s+measured/);
  });

  test("a viewport with no chrome region says the set is empty rather than printing a perfect 0/0", () => {
    const text = renderText(
      run([
        viewport("01-mobile-compact-360x800", [
          region("content.center-header", "content", diff(10, 100)),
        ]),
      ]),
    );
    expect(text).toContain("this viewport carries no chrome region");
    expect(text).toContain("A 0/0 here is an empty set, not a pass");
  });

  test("a viewport that does carry chrome regions makes no such claim", () => {
    const text = renderText(
      run([viewport("07-laptop-1366x768", [region("chrome.resizer", "chrome", diff(0, 5400))])]),
    );
    expect(text).not.toContain("this viewport carries no chrome region");
  });

  test("a failure is printed as a failure and the verdict is FAIL", () => {
    const text = renderText(run([viewport("01", [])], ["01 chrome.resizer: 3 differing pixel(s)"]));
    expect(text).toContain("FAIL 01 chrome.resizer: 3 differing pixel(s)");
    expect(text).toContain("RESULT: FAIL");
  });
});

describe("renderJson", () => {
  test("is parseable and carries one entry per viewport with both shares", () => {
    const summary = JSON.parse(
      renderJson(
        run([
          viewport("01", [
            region("chrome.resizer", "chrome", diff(0, 100)),
            region("content.x", "content", diff(5, 100)),
          ]),
        ]),
      ),
    ) as {
      verdict: string;
      viewports: { chromeShare: number; contentShare: number; chromeRegions: unknown[] }[];
    };
    expect(summary.verdict).toBe("PASS");
    expect(summary.viewports.length).toBe(1);
    expect(summary.viewports[0]?.chromeShare).toBe(0);
    expect(summary.viewports[0]?.contentShare).toBeCloseTo(0.05, 12);
    expect(summary.viewports[0]?.chromeRegions.length).toBe(1);
  });
});
