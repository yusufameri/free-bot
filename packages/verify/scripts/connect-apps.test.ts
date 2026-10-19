/**
 * The Connect apps driver's guards are pure, so they run without a browser or a launch. Each test
 * names the failure it prevents: a secret leaving in an artifact, and a screenshot whose state moved
 * under it.
 */

import { describe, expect, test } from "bun:test";
import { artifactRefusal, captureRefusals, factsEqual, secretsIn } from "../src/connect-apps.ts";

const secrets = [
  ["a", "freebot-connector-a-5f1c"],
  ["b", "freebot-connector-b-9d20"],
] as const;

describe("the artifact's credential census", () => {
  test("a text carrying one credential names its label, never its value", () => {
    expect(secretsIn("the vault line is freebot-connector-a-5f1c here", secrets)).toEqual(["a"]);
  });

  test("a clean text carries no label", () => {
    expect(secretsIn("the row answered connected with 2 tools", secrets)).toEqual([]);
  });

  test("an artifact carrying the operator token is refused", () => {
    expect(
      artifactRefusal(
        "url: http://127.0.0.1:1234/#token=operator-secret",
        secrets,
        "operator-secret",
      ),
    ).toBe("the artifact carries the operator token");
  });

  test("an artifact carrying a connector credential is refused by label", () => {
    expect(
      artifactRefusal("vault: FREEBOT_CONNECTOR_a=freebot-connector-a-5f1c", secrets, ""),
    ).toBe("the artifact carries a credential named a");
  });

  test("an artifact carrying a key-shaped literal is refused even when the run minted no key", () => {
    expect(artifactRefusal("FREEBOT_BYOK_KEY=someone-elses-key", secrets, "")).toBe(
      "the artifact carries a key-shaped literal",
    );
  });

  test("a clean artifact is written", () => {
    expect(
      artifactRefusal("ok - the screen listed two connectors", secrets, "operator-secret"),
    ).toBe(null);
  });
});

describe("the capture's stability guard", () => {
  test("identical facts pass the comparison", () => {
    expect(factsEqual({ state: "connected" }, { state: "connected" })).toBe(true);
  });

  test("a state that moved during the capture is caught", () => {
    expect(factsEqual({ state: "connected" }, { state: "unreachable" })).toBe(false);
  });

  test("a capture whose facts carry a credential is refused by label", () => {
    expect(
      captureRefusals(
        { refused: "no credential in freebot-connector-a-5f1c" },
        { refused: "no credential in freebot-connector-a-5f1c" },
        "the untested detail",
        secrets,
      ),
    ).toEqual(["the untested detail: its facts carry a"]);
  });

  test("a capture with clean, stable facts is accepted", () => {
    expect(
      captureRefusals(
        { state: "connected" },
        { state: "connected" },
        "the connected detail",
        secrets,
      ),
    ).toEqual([]);
  });
});
