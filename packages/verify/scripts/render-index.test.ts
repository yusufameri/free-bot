import { describe, expect, test } from "bun:test";
import { resolveBase } from "./render-index.ts";

describe("the index renderer's base", () => {
  test("resolves a short sha to the full commit the marker needs", () => {
    const calls: string[] = [];
    const full = `6e2683d${"0".repeat(33)}`;

    const base = resolveBase(["--base", "6e2683d"], (revision) => {
      calls.push(revision);
      return full;
    });

    expect(base).toBe(full);
    expect(calls).toEqual(["6e2683d^{commit}"]);
  });

  test("resolves a branch name rather than writing the name into the marker", () => {
    const calls: string[] = [];
    const full = "a".repeat(40);

    const base = resolveBase(["--base", "main"], (revision) => {
      calls.push(revision);
      return full;
    });

    expect(base).toBe(full);
    expect(calls).toEqual(["main^{commit}"]);
  });

  test("defaults to HEAD when no base is named", () => {
    const calls: string[] = [];

    resolveBase([], (revision) => {
      calls.push(revision);
      return "b".repeat(40);
    });

    expect(calls).toEqual(["HEAD^{commit}"]);
  });

  test("refuses --base with no value instead of silently rendering at HEAD", () => {
    expect(() => resolveBase(["--base"], () => "c".repeat(40))).toThrow("--base needs a commit");
  });
});
