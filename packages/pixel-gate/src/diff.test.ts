/**
 * The diff engine's arithmetic, driven in Bun over the same source the browser runs.
 *
 * `diff.ts` injects `diffRegion` and `digestImage` into the diff page with
 * `Function.prototype.toString`, so these calls are literally the code the browser executes on the
 * same inputs. A test that drove a re-implementation would prove nothing about the run.
 */

import { describe, expect, test } from "bun:test";
import { diffRegion, digestImage, IN_PAGE_RUNTIME } from "./diff.ts";

/** A field of one RGBA colour, `width` by `height`, as a `Uint8ClampedArray`. */
function field(width: number, height: number, rgba: readonly [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = rgba[0];
    data[at + 1] = rgba[1];
    data[at + 2] = rgba[2];
    data[at + 3] = rgba[3];
  }
  return data;
}

function paint(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
): void {
  const at = (y * width + x) * 4;
  data[at] = rgba[0];
  data[at + 1] = rgba[1];
  data[at + 2] = rgba[2];
  data[at + 3] = rgba[3];
}

describe("diffRegion", () => {
  test("two identical rectangles differ nowhere and have no mean difference", () => {
    const a = field(4, 3, [10, 20, 30, 255]);
    const b = field(4, 3, [10, 20, 30, 255]);
    const stat = diffRegion(a, b, 4, 0, 0, 4, 3);
    expect(stat.differing).toBe(0);
    expect(stat.total).toBe(12);
    expect(stat.share).toBe(0);
    expect(stat.meanAbsolute).toBe(0);
    expect(stat.maxChannel).toBe(0);
    expect(stat.visible).toBe(0);
  });

  test("one pixel of a one-channel change counts as one differing pixel and nothing more", () => {
    const a = field(4, 3, [10, 20, 30, 255]);
    const b = field(4, 3, [10, 20, 30, 255]);
    paint(b, 4, 2, 1, [11, 20, 30, 255]);
    const stat = diffRegion(a, b, 4, 0, 0, 4, 3);
    expect(stat.differing).toBe(1);
    expect(stat.total).toBe(12);
    expect(stat.maxChannel).toBe(1);
    expect(stat.visible).toBe(0);
    expect(stat.meanAbsolute).toBeCloseTo(1 / (12 * 4), 10);
  });

  test("the rectangle restricts the count, so a change outside it is invisible", () => {
    const a = field(8, 8, [0, 0, 0, 255]);
    const b = field(8, 8, [0, 0, 0, 255]);
    // A change at 6,6 and one at 1,1. Only the second is inside the 4x4 rectangle at the origin.
    paint(b, 8, 6, 6, [255, 255, 255, 255]);
    paint(b, 8, 1, 1, [255, 255, 255, 255]);
    const stat = diffRegion(a, b, 8, 0, 0, 4, 4);
    expect(stat.differing).toBe(1);
    expect(stat.total).toBe(16);
    // And the rectangle that excludes both reports nothing.
    const away = diffRegion(a, b, 8, 4, 4, 2, 2);
    expect(away.differing).toBe(0);
    expect(away.total).toBe(4);
  });

  test("the threshold separates a real change from sub-perceptual noise", () => {
    const a = field(2, 1, [100, 100, 100, 255]);
    const b = field(2, 1, [100, 100, 100, 255]);
    paint(b, 2, 0, 0, [108, 100, 100, 255]); // worst channel 8, at the threshold
    paint(b, 2, 1, 0, [109, 100, 100, 255]); // worst channel 9, over it
    const stat = diffRegion(a, b, 2, 0, 0, 2, 1);
    expect(stat.differing).toBe(2);
    expect(stat.visible).toBe(1);
  });

  test("the alpha channel counts, so a transparent pixel over a colour is a difference", () => {
    const a = field(1, 1, [255, 255, 255, 255]);
    const b = field(1, 1, [255, 255, 255, 0]);
    const stat = diffRegion(a, b, 1, 0, 0, 1, 1);
    expect(stat.differing).toBe(1);
    expect(stat.maxChannel).toBe(255);
  });

  test("a rectangle with no area has no statistic rather than a division by zero", () => {
    const a = field(2, 2, [0, 0, 0, 255]);
    const stat = diffRegion(a, a, 2, 0, 0, 0, 0);
    expect(stat.total).toBe(0);
    expect(stat.share).toBe(0);
    expect(stat.meanAbsolute).toBe(0);
  });

  test("meanAbsolute is the mean over four channels, not over pixels", () => {
    const a = field(1, 1, [0, 0, 0, 0]);
    const b = field(1, 1, [4, 4, 4, 4]);
    const stat = diffRegion(a, b, 1, 0, 0, 1, 1);
    expect(stat.meanAbsolute).toBe(4);
    expect(stat.maxChannel).toBe(4);
  });
});

describe("digestImage", () => {
  test("identical bytes digest equally and a one-channel one-byte change does not", () => {
    const a = field(3, 3, [7, 8, 9, 255]);
    const b = field(3, 3, [7, 8, 9, 255]);
    expect(digestImage(a)).toBe(digestImage(b));
    paint(b, 3, 1, 1, [7, 8, 10, 255]);
    expect(digestImage(a)).not.toBe(digestImage(b));
  });

  test("the digest is fixed-width hex, so two digests can be compared as strings", () => {
    const digest = digestImage(field(1, 1, [0, 0, 0, 255]));
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the empty buffer has a digest rather than throwing", () => {
    expect(digestImage(new Uint8ClampedArray(0))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the injected runtime", () => {
  test("carries the same two functions this file just drove", () => {
    expect(IN_PAGE_RUNTIME.includes(diffRegion.toString())).toBe(true);
    expect(IN_PAGE_RUNTIME.includes(digestImage.toString())).toBe(true);
  });

  test("declares the surface the run calls: begin, put, compare and crop", () => {
    for (const name of ["begin", "put", "compare", "crop"]) {
      expect(IN_PAGE_RUNTIME.includes(`${name}(`)).toBe(true);
    }
  });

  test("compare and crop take the two shot names, so a repeat pair is a comparison like any other", () => {
    expect(IN_PAGE_RUNTIME.includes("async compare(left, right, regions)")).toBe(true);
    expect(IN_PAGE_RUNTIME.includes("async crop(left, right, rect, scale)")).toBe(true);
    expect(IN_PAGE_RUNTIME.includes("await load(left)")).toBe(true);
    expect(IN_PAGE_RUNTIME.includes("await load(right)")).toBe(true);
  });

  test("begin clears both the shots and the decoded copies, so a viewport cannot inherit another", () => {
    expect(IN_PAGE_RUNTIME.includes("delete shots[name]")).toBe(true);
    expect(IN_PAGE_RUNTIME.includes("delete drawn[name]")).toBe(true);
  });

  test("is one expression that returns, so a CDP evaluate can run it as an expression", () => {
    expect(IN_PAGE_RUNTIME.trimStart().startsWith("(() =>")).toBe(true);
    expect(IN_PAGE_RUNTIME.trimEnd().endsWith("})()")).toBe(true);
  });

  test("keeps no backtick, so the template that builds it cannot be terminated early", () => {
    expect(IN_PAGE_RUNTIME.includes("`")).toBe(false);
  });
});
