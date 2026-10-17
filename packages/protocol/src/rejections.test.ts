/**
 * The rejection list the verify artifact prints is the list this test asserts, read from one
 * table. The spot checks below pin individual literal messages so a silently weakened table
 * (an empty `error`, a case that starts parsing) fails loudly rather than passing vacuously.
 */

import { describe, expect, test } from "bun:test";
import { runRejections } from "../scripts/rejections.ts";

const rows = runRejections();
const row = (name: string) => rows.find((entry) => entry.name === name);

describe("the rejection list", () => {
  test("every case is refused with exactly the recorded literal", () => {
    expect(rows.length).toBe(23);
    expect(rows.filter((entry) => !entry.ok)).toEqual([]);
  });

  test("the case names are the documented list", () => {
    expect(rows.map((entry) => entry.name)).toEqual([
      "unknown kind",
      "missing kind",
      "wrong version tag",
      "missing seq",
      "seq 0",
      "non-integer seq",
      "seq as a string",
      "run-scoped message without a runId",
      "missing payload",
      "payload field of the wrong type",
      "denial without a reason code",
      "reason code outside the ten",
      "denial without a detail",
      "action hash that is not v1:sha256:<64 hex>",
      "grant state outside the four",
      "consumed grant without its consumer",
      "negative resume point",
      "unknown key on a command input (strict)",
      "unknown key on an approval answer (strict)",
      "negative event cursor",
      "event page over the cap",
      "absolute file path",
      "parent-directory traversal",
    ]);
  });

  test("three cases pin their literal text", () => {
    expect(row("seq 0")?.actual).toBe("Too small: expected number to be >0");
    expect(row("unknown key on a command input (strict)")?.actual).toBe(
      'Unrecognized key: "extra"',
    );
    expect(row("parent-directory traversal")?.actual).toBe(
      "path must be relative to /workspace without .. segments",
    );
  });

  test("no case is recorded as accepted", () => {
    expect(rows.filter((entry) => entry.actual === "<accepted>")).toEqual([]);
  });
});
