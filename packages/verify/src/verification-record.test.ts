import { describe, expect, test } from "bun:test";
import {
  claimedCheckCount,
  indexBase,
  parseRow,
  readResult,
  renderIndex,
  statedCommit,
  type VerificationRow,
} from "./verification-record.ts";

const row = (overrides: Partial<VerificationRow> = {}): VerificationRow => ({
  file: "demo.md",
  feature: "demo",
  script: "`bun demo.ts`",
  verdict: "unit-test-verified (2 checks)",
  artifact: "`packages/verify/artifacts/demo/abc1234/assert.txt`",
  commit: `abc1234${"0".repeat(33)}`,
  date: "2026-10-19",
  legacyCount: null,
  legacyHeader: null,
  redDrivers: [],
  ...overrides,
});

describe("the row file format", () => {
  test("a complete file parses to the six authored cells", () => {
    const parsed = parseRow(
      "demo.md",
      `${[
        "feature: demo",
        "script: `bun demo.ts`",
        "verdict: unit-test-verified (2 checks)",
        "artifact: `packages/verify/artifacts/demo/abc1234/assert.txt`",
        `commit: ${"a".repeat(40)}`,
        "date: 2026-10-19",
        "red-driver: demo@abc1234",
      ].join("\n")}\n`,
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.row?.feature).toBe("demo");
    expect(parsed.row?.commit).toBe("a".repeat(40));
    expect(parsed.row?.redDrivers).toEqual([{ driver: "demo", sweep: "abc1234" }]);
  });

  test("an unknown key fails by name rather than being ignored", () => {
    const parsed = parseRow("demo.md", "feature: demo\nwibble: 1\n");
    expect(parsed.row).toBeNull();
    expect(parsed.problems.map((problem) => problem.message)).toContain(
      'line 2: unknown key "wibble"',
    );
  });

  test("a pipe in a cell fails, because it would split the rendered table", () => {
    const parsed = parseRow(
      "demo.md",
      `feature: demo\nscript: a | b\nverdict: x\nartifact: y\ncommit: ${"a".repeat(40)}\ndate: 2026-10-19\n`,
    );
    expect(parsed.row).toBeNull();
    expect(parsed.problems.map((problem) => problem.message)).toContain(
      'line 2: "script" carries a pipe or a newline',
    );
  });

  test("a short commit and a malformed date are rejected", () => {
    const parsed = parseRow(
      "demo.md",
      "feature: demo\nscript: x\nverdict: y\nartifact: z\ncommit: abc1234\ndate: 19-10-2026\n",
    );
    expect(parsed.problems.map((problem) => problem.message)).toContain(
      'commit "abc1234" is not a full 40-character git sha',
    );
    expect(parsed.problems.map((problem) => problem.message)).toContain(
      'date "19-10-2026" is not YYYY-MM-DD',
    );
  });
});

describe("the renderer", () => {
  test("renders the six authored cells verbatim plus the row's distance", () => {
    const text = renderIndex([row()], {
      base: "f".repeat(40),
      behind: () => 12,
      notes: () => [],
    });

    expect(text).toContain(`<!-- verification-index base: ${"f".repeat(40)} -->`);
    expect(text).toContain(
      `| demo | \`bun demo.ts\` | unit-test-verified (2 checks) | \`packages/verify/artifacts/demo/abc1234/assert.txt\` | ${row().commit} | 2026-10-19 | 12 |`,
    );
    expect(indexBase(text)).toBe("f".repeat(40));
  });

  test("orders by date then feature, so a row set renders the same bytes every time", () => {
    const older = row({ file: "a.md", feature: "alpha", date: "2026-10-18" });
    const later = row({ file: "b.md", feature: "beta", date: "2026-10-19" });
    const context = { base: "f".repeat(40), behind: () => 0, notes: () => [] };

    expect(renderIndex([later, older], context)).toBe(renderIndex([older, later], context));
    expect(renderIndex([later, older], context).indexOf("| alpha |")).toBeLessThan(
      renderIndex([later, older], context).indexOf("| beta |"),
    );
  });

  test("At main carries the notes the checker computed", () => {
    const text = renderIndex([row({ redDrivers: [{ driver: "demo", sweep: "abc1234" }] })], {
      base: "f".repeat(40),
      behind: () => 3,
      notes: () => ["Red at main: the demo driver failed RESULT: FAIL (1/2) in sweep abc1234"],
    });

    expect(text).toContain(
      "| 3; Red at main: the demo driver failed RESULT: FAIL (1/2) in sweep abc1234 |",
    );
  });
});

describe("the artifact readers", () => {
  test("the last RESULT line wins and a fraction becomes a count", () => {
    expect(readResult("RESULT: FAIL (1/2)\nmore\nRESULT: PASS (2/3)\n")).toEqual({
      kind: "counted",
      line: "RESULT: PASS (2/3)",
      status: "PASS",
      passed: 2,
      total: 3,
    });
  });

  test("a RESULT line with no fraction is uncounted rather than zero", () => {
    expect(readResult("RESULT: PASS\n")).toEqual({
      kind: "uncounted",
      line: "RESULT: PASS",
      status: "PASS",
    });
  });

  test("a bare count is a claim with an unknown total", () => {
    expect(claimedCheckCount("unit-test-verified (20 checks)")).toEqual({
      passed: 20,
      total: null,
    });
    expect(claimedCheckCount("live-ui-verified (115/116 checks)")).toEqual({
      passed: 115,
      total: 116,
    });
    expect(claimedCheckCount("passes 57/57 at this head")).toBeNull();
  });

  test("a stated commit is the header first, then a full sha the artifact prints", () => {
    expect(statedCommit(`git sha: ${"a".repeat(40)}\n`)).toEqual({
      sha: "a".repeat(40),
      kind: "header",
    });
    expect(statedCommit(`commit ${"b".repeat(40)} in a sentence\n`)).toEqual({
      sha: "b".repeat(40),
      kind: "mentioned",
    });
    expect(statedCommit("no sha here\n")).toBeNull();
  });
});
