/**
 * The first-run screen's model, read the way the DOM module reads it: which pane the step is on,
 * which words that pane carries, and whether the primary can be pressed.
 *
 * Every string here is asserted against a literal, because the export governs them and a one-word
 * edit should fail this file rather than reach a person.
 */

import { describe, expect, test } from "bun:test";
import {
  CONTINUE_LABEL,
  chosenJob,
  EMPTY_DRAFT,
  FIRST_RUN_JOBS,
  nextStep,
  paneValid,
  primaryLabel,
  purposeLine,
  SKIP_LABEL,
  START_LABEL,
  STEP_CAPTIONS,
} from "./first-run.ts";

describe("the first-run screen's panes", () => {
  test("three panes, in the export's order, with the export's captions", () => {
    expect([STEP_CAPTIONS[1], STEP_CAPTIONS[2], STEP_CAPTIONS[3]]).toEqual([
      "01 / 03 — NAME",
      "02 / 03 — PURPOSE",
      "03 / 03 — FIRST TASK",
    ]);
  });

  test("every caption separates its number from its word with the export's em dash", () => {
    expect(
      [STEP_CAPTIONS[1], STEP_CAPTIONS[2], STEP_CAPTIONS[3]].every(
        (caption) => caption.split(" — ").length === 2,
      ),
    ).toBe(true);
  });

  test("Continue advances one pane and the last pane has nothing after it", () => {
    expect(nextStep(1)).toBe(2);
    expect(nextStep(2)).toBe(3);
    expect(nextStep(3)).toBeNull();
  });

  test("the primary is Continue until the last pane, then Start working", () => {
    expect([primaryLabel(1), primaryLabel(2), primaryLabel(3)]).toEqual([
      CONTINUE_LABEL,
      CONTINUE_LABEL,
      START_LABEL,
    ]);
    expect([CONTINUE_LABEL, START_LABEL, SKIP_LABEL]).toEqual([
      "Continue",
      "Start working",
      "Skip",
    ]);
  });

  test("a blank name holds the first pane, a blank purpose the second, and a job is optional", () => {
    expect(paneValid(1, EMPTY_DRAFT)).toBe(false);
    expect(paneValid(1, { ...EMPTY_DRAFT, name: "   " })).toBe(false);
    expect(paneValid(1, { ...EMPTY_DRAFT, name: "Atlas" })).toBe(true);

    expect(paneValid(2, { ...EMPTY_DRAFT, name: "Atlas" })).toBe(false);
    expect(paneValid(2, { ...EMPTY_DRAFT, name: "Atlas", purpose: "Release pipeline" })).toBe(true);

    expect(paneValid(3, { ...EMPTY_DRAFT, name: "Atlas" })).toBe(true);
  });

  test("the four suggested jobs are the export's, each with the prompt it prefills", () => {
    expect(FIRST_RUN_JOBS.map((job) => [job.label, job.task])).toEqual([
      [
        "Audit for committed secrets",
        "Audit the repo for committed secrets and draft the cleanup.",
      ],
      ["Draft this week's changelog", "Draft this week's changelog from merged PRs."],
      ["Sweep dependencies", "Sweep dependencies and report what is stale, with a plan."],
      ["Summarise since last release", "Summarise what changed in main since the last release."],
    ]);
    expect(chosenJob(EMPTY_DRAFT)).toBeNull();
    expect(chosenJob({ ...EMPTY_DRAFT, jobIndex: 2 })?.label).toBe("Sweep dependencies");
    expect(chosenJob({ ...EMPTY_DRAFT, jobIndex: 9 })).toBeNull();
  });

  test("the purpose is one line, with no space kept around it", () => {
    expect(
      purposeLine({ ...EMPTY_DRAFT, purpose: "  Keeps   the release\npipeline moving.  " }),
    ).toBe("Keeps the release pipeline moving.");
    expect(purposeLine(EMPTY_DRAFT)).toBe("");
  });
});
