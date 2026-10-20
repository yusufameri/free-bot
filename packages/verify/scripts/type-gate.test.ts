/**
 * The gate's plant/restore pair, driven on its own. The full probe runs two typechecks per case, so
 * its record of a restored tree cannot tell a working restore from a passing one. These tests read
 * the bytes instead: plant the same three paths the gate plants, restore them, and compare the tree
 * to the snapshot taken before anything was written.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BROKEN, cases, placeProbe, restoreProbes } from "./type-gate.ts";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "freebot-type-gate-"));
  mkdirSync(join(root, "apps/web/scripts"), { recursive: true });
  mkdirSync(join(root, "packages/protocol/scripts"), { recursive: true });
  writeFileSync(join(root, "apps/web/scripts/keep.ts"), "export const keep = 1;\n");
  writeFileSync(join(root, "packages/protocol/scripts/keep.tsx"), "export const keep = <p />;\n");
  return root;
}

/** Every file under the tree and its bytes, so a restore is compared as a tree, not as a path. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files[relative(root, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return files;
}

describe("the type gate's plant and restore", () => {
  test("all three probes are planted, then the tree is byte-identical to its start", () => {
    const root = fixtureRoot();
    const before = snapshot(root);

    for (const probe of cases) placeProbe(root, probe.path);
    for (const probe of cases) {
      expect(readFileSync(join(root, probe.path), "utf8")).toBe(BROKEN);
    }
    expect(Object.keys(snapshot(root)).sort()).toEqual(
      [...Object.keys(before), ...cases.map((probe) => probe.path)].sort(),
    );

    restoreProbes(
      root,
      cases.map((probe) => probe.path),
    );

    expect(snapshot(root)).toEqual(before);
    for (const probe of cases) expect(existsSync(join(root, probe.path))).toBe(false);
  });

  test("a path that already holds a file is refused and keeps its bytes", () => {
    const root = fixtureRoot();
    const [probe] = cases;
    if (probe === undefined) throw new Error("the gate ships no probe cases");
    const path = join(root, probe.path);
    writeFileSync(path, "export const real = 1;\n");

    expect(() => placeProbe(root, probe.path)).toThrow(/refusing to overwrite/);
    expect(readFileSync(path, "utf8")).toBe("export const real = 1;\n");
  });
});
