import { describe, expect, test } from "bun:test";
import { probeWithRetry } from "./doctor.ts";

describe("the doctor's bounded probe retry", () => {
  test("a probe that passes is not retried", () => {
    let calls = 0;
    const result = probeWithRetry(
      () => ++calls,
      () => true,
      0,
    );
    expect(result).toBe(1);
    expect(calls).toBe(1);
  });

  test("a probe that fails once is retried, and the second result is the one returned", () => {
    let calls = 0;
    const result = probeWithRetry(
      () => ++calls >= 2,
      (ok) => ok,
      0,
    );
    expect(result).toBe(true);
    expect(calls).toBe(2);
  });

  test("a probe that keeps failing returns its failure after exactly one retry", () => {
    let calls = 0;
    const result = probeWithRetry(
      () => ++calls,
      () => false,
      0,
    );
    expect(result).toBe(2);
    expect(calls).toBe(2);
  });
});
