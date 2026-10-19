/**
 * The declared deltas are one list, and this test is what keeps it one list.
 *
 * `docs/DESIGN-CONTRACT.md` carries a fenced JSON copy of `DECLARED_BOX_DELTAS` between two markers.
 * `packages/verify/scripts/design-contract.ts` re-exports the same array as `DECLARED_DELTAS`. A
 * reader can therefore check the contract's numbers against the gate's, and a writer who changes one
 * copy without the other fails here rather than shipping two delta lists.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DECLARED_DELTAS } from "../../verify/scripts/design-contract.ts";
import { DECLARED_BOX_DELTAS, declaredBoxDelta } from "./deltas.ts";
import { REGIONS } from "./regions.ts";

const CONTRACT = new URL("../../../docs/DESIGN-CONTRACT.md", import.meta.url);

function documented(): unknown {
  const text = readFileSync(CONTRACT, "utf8");
  const start = text.indexOf("<!-- pixel-gate-deltas:begin -->");
  const end = text.indexOf("<!-- pixel-gate-deltas:end -->");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = text.slice(start, end);
  const fenced = /```json\n([\s\S]*?)\n```/.exec(block);
  expect(fenced).not.toBeNull();
  return JSON.parse(fenced?.[1] ?? "");
}

describe("the declared delta list", () => {
  test("the contract's fenced copy equals the module", () => {
    expect(documented()).toEqual(JSON.parse(JSON.stringify(DECLARED_BOX_DELTAS)));
  });

  test("design-contract's DECLARED_DELTAS is the same array", () => {
    expect(DECLARED_DELTAS).toBe(DECLARED_BOX_DELTAS);
  });

  test("every declared field names a region the map carries", () => {
    for (const entry of DECLARED_BOX_DELTAS) {
      const id = entry.field.replace(/^pixel-gate /, "");
      expect(REGIONS.some((region) => region.id === id)).toBe(true);
      expect(declaredBoxDelta(id)).toBe(entry);
    }
  });

  test("every declared region is a content region, because chrome must agree", () => {
    for (const entry of DECLARED_BOX_DELTAS) {
      const id = entry.field.replace(/^pixel-gate /, "");
      const region = REGIONS.find((candidate) => candidate.id === id);
      expect(region?.kind).toBe("content");
    }
  });

  test("every entry carries a reason and the viewports its region is carried on", () => {
    for (const entry of DECLARED_BOX_DELTAS) {
      expect(entry.reason.length).toBeGreaterThan(80);
      expect(Object.keys(entry.pixels).length).toBeGreaterThan(0);
      expect(entry.allow.length).toBeGreaterThan(0);
    }
  });

  test("a nonzero pixel in an entry appears among its allowed magnitudes", () => {
    for (const entry of DECLARED_BOX_DELTAS) {
      for (const delta of Object.values(entry.pixels)) {
        for (const value of [delta.left, delta.top, delta.width, delta.height]) {
          if (value === 0) continue;
          expect(entry.allow).toContain(Math.abs(value));
        }
      }
    }
  });
});
