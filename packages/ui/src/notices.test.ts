/**
 * The notices and the banner: what raises each one, what it says, and that dismissing one keeps it
 * dismissed.
 *
 * Every text asserted here is a literal the page shows, and the two provider lines are the words
 * page 1 already uses, so the same outcome cannot read two ways.
 */

import { describe, expect, test } from "bun:test";
import type { ProviderConnection, RunSummary } from "@freebot/protocol";
import { BANNER_TEXT, bannerAfter, noticesFrom, readDismissed, undismissed } from "./notices.ts";
import { LIMITED_HEADLINE, UNTESTED_HEADLINE } from "./provider.ts";

const CONNECTION: ProviderConnection = {
  baseUrl: "http://127.0.0.1:9/contract-not-a-provider",
  model: "design-contract-placeholder",
  status: "capable",
  testedAt: null,
  flags: null,
  refusal: null,
  answer: null,
};

const FAILED: RunSummary = {
  runId: "run-2",
  prompt: "second",
  status: "failed",
  startedAt: 1_700_000_000_000,
};

const DONE: RunSummary = { ...FAILED, runId: "run-1", status: "done" };

describe("the banner", () => {
  test("it is the export's own copy, verbatim", () => {
    expect(BANNER_TEXT).toBe(
      "Reconnecting — the stream dropped. The transcript refills from the last event it held.",
    );
  });

  test("it stands once the stream was reported down, and clears only on an open socket", () => {
    expect(bannerAfter(false, "connecting")).toBe(false);
    expect(bannerAfter(false, "connected")).toBe(false);
    expect(bannerAfter(false, "reconnecting")).toBe(true);
    expect(bannerAfter(true, "connecting")).toBe(true);
    expect(bannerAfter(true, "connected")).toBe(false);
    expect(bannerAfter(true, "error")).toBe(true);
  });
});

describe("what raises a notice", () => {
  test("a capable connection and a run that did not fail raise nothing", () => {
    expect(noticesFrom({ connection: CONNECTION, latest: DONE })).toEqual([]);
    expect(noticesFrom({ connection: CONNECTION, latest: null })).toEqual([]);
  });

  test("an untested connection raises the headline page 1 uses, with one action", () => {
    const notices = noticesFrom({
      connection: { ...CONNECTION, status: "untested" },
      latest: null,
    });
    expect(notices).toEqual([
      { id: "provider-untested", text: UNTESTED_HEADLINE, action: "open-provider" },
    ]);
    expect(UNTESTED_HEADLINE).toBe("The connection did not pass its test");
  });

  test("a limited connection raises the limited headline", () => {
    const notices = noticesFrom({ connection: { ...CONNECTION, status: "limited" }, latest: null });
    expect(notices).toEqual([
      { id: "provider-limited", text: LIMITED_HEADLINE, action: "open-provider" },
    ]);
  });

  test("a refusal adds the provider's own sentence to the headline", () => {
    const notices = noticesFrom({
      connection: {
        ...CONNECTION,
        status: "untested",
        refusal: { status: 401, message: "invalid api key" },
      },
      latest: null,
    });
    expect(notices[0]?.text).toBe(
      `${UNTESTED_HEADLINE} The provider refused the test (401): invalid api key`,
    );
  });

  test("a failed run raises a notice whose id names the run", () => {
    const notices = noticesFrom({ connection: CONNECTION, latest: FAILED });
    expect(notices).toEqual([{ id: "run-failed-run-2", text: "Run run-2 failed.", action: null }]);
  });

  test("the provider's outcome stacks above the run's", () => {
    const notices = noticesFrom({
      connection: { ...CONNECTION, status: "untested" },
      latest: FAILED,
    });
    expect(notices.map((notice) => notice.id)).toEqual(["provider-untested", "run-failed-run-2"]);
  });

  test("a page with no connection at all raises nothing rather than guessing", () => {
    expect(noticesFrom({ connection: null, latest: DONE })).toEqual([]);
  });
});

describe("dismissals", () => {
  const notices = noticesFrom({
    connection: { ...CONNECTION, status: "untested" },
    latest: FAILED,
  });

  test("a dismissed notice leaves the stack, the others stay", () => {
    expect(undismissed(notices, ["provider-untested"]).map((notice) => notice.id)).toEqual([
      "run-failed-run-2",
    ]);
    expect(undismissed(notices, ["provider-untested", "run-failed-run-2"])).toEqual([]);
    expect(undismissed(notices, [])).toHaveLength(2);
  });

  test("what a page stored is read back, and nonsense reads as nothing dismissed", () => {
    expect(readDismissed('["provider-untested","run-failed-run-2"]')).toEqual([
      "provider-untested",
      "run-failed-run-2",
    ]);
    expect(readDismissed(null)).toEqual([]);
    expect(readDismissed("not json")).toEqual([]);
    expect(readDismissed('{"id":"provider-untested"}')).toEqual([]);
    expect(readDismissed('["provider-untested",7]')).toEqual(["provider-untested"]);
  });
});
