#!/usr/bin/env bun
/**
 * The rejection list as data: one row per case, the literal zod message each input draws.
 *
 * Both the unit test (`src/rejections.test.ts`) and the verify runner read
 * `fixtures/rejections.json`, so the list a reviewer sees in assert.txt is the list the test
 * asserts, character for character. Run from the repo root:
 * bun packages/protocol/scripts/rejections.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_OPERATIONS, type ApiOperation, safeParseMessage } from "../src/index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export const REJECTION_CASES_FILE = "packages/protocol/fixtures/rejections.json";

export interface RejectionCase {
  name: string;
  schema: "message" | ApiOperation;
  input: unknown;
  error: string;
}

export interface RejectionRow {
  name: string;
  schema: string;
  /** The literal first issue message, or `<accepted>` when the input parsed. */
  actual: string;
  ok: boolean;
}

export function loadRejectionCases(repoRoot = root): RejectionCase[] {
  return JSON.parse(readFileSync(join(repoRoot, REJECTION_CASES_FILE), "utf8")) as RejectionCase[];
}

function firstIssue(caseToRun: RejectionCase): string | null {
  if (caseToRun.schema === "message") {
    const result = safeParseMessage(caseToRun.input);
    return result.success ? null : (result.error.issues[0]?.message ?? "<no issue>");
  }
  const operation = API_OPERATIONS[caseToRun.schema];
  const result = operation.input.safeParse(caseToRun.input);
  return result.success ? null : (result.error.issues[0]?.message ?? "<no issue>");
}

/** Every case must be refused with exactly the message the table records. */
export function runRejections(repoRoot = root): RejectionRow[] {
  return loadRejectionCases(repoRoot).map((caseToRun) => {
    const actual = firstIssue(caseToRun) ?? "<accepted>";
    return {
      name: caseToRun.name,
      schema: caseToRun.schema,
      actual,
      ok: actual === caseToRun.error,
    };
  });
}

if (import.meta.main) {
  const rows = runRejections();
  console.log(`${REJECTION_CASES_FILE}: ${rows.length} cases, all refused`);
  console.log("");
  for (const row of rows) {
    console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.schema.padEnd(10)} ${row.name}`);
    console.log(`      ${row.actual}`);
  }
  const failed = rows.filter((row) => !row.ok).length;
  console.log("");
  console.log(
    `${failed === 0 ? "PASS" : "FAIL"} rejections: ${rows.length - failed}/${rows.length}`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}
