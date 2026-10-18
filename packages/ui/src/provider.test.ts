/**
 * Page 1's model: the state a connection earns, the copy for each state, and the lines the page and
 * the evidence both read. These are the pure functions; the DOM that renders them is asserted on the
 * live surface by `packages/verify/scripts/provider-setup.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "@freebot/protocol";
import {
  answerLine,
  capabilityLines,
  CAPABLE_HEADLINE,
  endpointLine,
  LIMITED_HEADLINE,
  pageStateOf,
  providerHeadline,
  providerRowLabel,
  refusalLine,
  replacesLine,
  resultLine,
  statusLine,
  UNTESTED_HEADLINE,
  vaultLine,
} from "./provider.ts";

const CONNECTION: ProviderConnection = {
  baseUrl: "https://api.commandcode.ai/provider/v1",
  model: "deepseek/deepseek-v4.1-flash",
  status: "capable",
  testedAt: 1_792_221_550_000,
  flags: {
    toolCalling: "strong",
    streaming: true,
    structuredOutput: null,
    contextWindow: null,
    notes: ["native tool call(s): freebot_smoke_echo"],
  },
  refusal: null,
  answer: "save-time-smoke",
};

describe("the page's state", () => {
  test("a testing save is the testing state whatever the last answer was", () => {
    expect(pageStateOf(null, false)).toBe("empty");
    expect(pageStateOf(CONNECTION, false)).toBe("capable");
    expect(pageStateOf(CONNECTION, true)).toBe("testing");
    expect(pageStateOf(null, true)).toBe("testing");
  });

  test("each state gets its own headline and its own reason", () => {
    expect(providerHeadline("empty")).toBe("Connect a provider");
    expect(providerHeadline("testing")).toBe("Testing the connection...");
    expect(providerHeadline("capable")).toBe(CAPABLE_HEADLINE);
    expect(providerHeadline("limited")).toBe(LIMITED_HEADLINE);
    expect(providerHeadline("untested")).toBe(UNTESTED_HEADLINE);
    expect(resultLine(null)).toContain("FreeBot ships no subscription");
    expect(resultLine(CONNECTION)).toContain("called a tool");
    expect(resultLine({ ...CONNECTION, status: "limited" })).toContain("structured output fallback");
    expect(resultLine({ ...CONNECTION, status: "untested", flags: null })).toContain(
      "fails with the provider's own words",
    );
  });
});

describe("what the page shows about a connection", () => {
  test("the endpoint line is the request the test makes", () => {
    expect(endpointLine("https://api.example.com/v1", "gpt-4o-mini")).toBe(
      "POST https://api.example.com/v1/chat/completions  model gpt-4o-mini",
    );
    expect(endpointLine("https://api.example.com/v1/", "gpt-4o-mini")).toBe(
      "POST https://api.example.com/v1/chat/completions  model gpt-4o-mini",
    );
    expect(endpointLine("", "gpt-4o-mini")).toBe("");
  });

  test("the flags read the way the smoke's own report spells them, unknown and all", () => {
    expect(capabilityLines(CONNECTION.flags)).toEqual([
      "tool calling: strong",
      "streaming: true",
      "structured output: unknown",
      "context window: unknown",
    ]);
    expect(capabilityLines(null)).toEqual([]);
  });

  test("a refusal names the provider's own status code, and a failure without one says so", () => {
    expect(refusalLine({ status: 401, message: "auth rejected (401): invalid api key" })).toBe(
      "The provider refused the test (401): auth rejected (401): invalid api key",
    );
    expect(refusalLine({ status: null, message: "fetch failed" })).toBe(
      "The test could not reach the provider: fetch failed",
    );
  });

  test("the answer is shown only for a connection that got one", () => {
    expect(answerLine(CONNECTION)).toBe("save-time-smoke");
    expect(answerLine({ ...CONNECTION, answer: "" })).toBe("The test turn returned no text.");
    expect(answerLine({ ...CONNECTION, status: "untested", answer: "half a reply" })).toBeNull();
    expect(answerLine(null)).toBeNull();
  });

  test("the vault is named by its path and mode and never by its contents", () => {
    expect(vaultLine({ path: "/home/p/.freebot/provider.env", present: true, mode: "600" })).toBe(
      "Vault: /home/p/.freebot/provider.env (present, mode 600)",
    );
    expect(vaultLine({ path: "/home/p/.freebot/provider.env", present: false, mode: null })).toBe(
      "Vault: /home/p/.freebot/provider.env (nothing written yet)",
    );
  });

  test("a save says what it replaces before it replaces it", () => {
    expect(replacesLine({ path: "/home/p/.freebot/provider.env", present: true, mode: "600" }, CONNECTION)).toBe(
      "Saving replaces this machine's connection: deepseek/deepseek-v4.1-flash at api.commandcode.ai, held in /home/p/.freebot/provider.env.",
    );
    expect(
      replacesLine({ path: "/home/p/.freebot/provider.env", present: false, mode: null }, null),
    ).toBeNull();
  });

  test("the footer row names the active connection and its capability", () => {
    expect(providerRowLabel(CONNECTION)).toBe("deepseek/deepseek-v4.1-flash · capable");
    expect(providerRowLabel(null)).toBe("Connect a provider");
  });

  test("the one line under the form follows the state", () => {
    expect(statusLine("empty", "", null)).toBe("");
    expect(statusLine("testing", endpointLine(CONNECTION.baseUrl, CONNECTION.model), null)).toBe(
      `Waiting for the reply. ${endpointLine(CONNECTION.baseUrl, CONNECTION.model)}`,
    );
    expect(statusLine("capable", "", null)).toBe("Saved.");
    expect(statusLine("untested", "", null)).toBe("Saved, untested.");
    expect(statusLine("capable", "", "the RPC refused the input")).toBe("the RPC refused the input");
  });
});
