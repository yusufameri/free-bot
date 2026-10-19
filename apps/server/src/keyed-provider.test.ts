import { describe, expect, test } from "bun:test";
import type { TokenPrices, ToolDefinition, ToolOutcome } from "@freebot/core";
import { ProviderTurnError } from "@freebot/core";
import { createFakeTransport, jsonResponse, OpenAiCompatibleClient } from "@freebot/providers";
import { KeyedProvider, outcomeText } from "./keyed-provider.ts";

const API_KEY = "vault-key-for-the-adapter-test";
const CONNECTION = { baseUrl: "http://provider.test/v1", apiKey: API_KEY };

const TOOLS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

const completion = (message: Record<string, unknown>, finishReason = "stop") => ({
  id: "chatcmpl-1",
  choices: [{ index: 0, message, finish_reason: finishReason }],
  usage: { prompt_tokens: 118, completion_tokens: 23, total_tokens: 141 },
});

const CALL = {
  id: "call_1",
  type: "function",
  function: { name: "bash", arguments: '{"command":"echo hi"}' },
};

function providerWith(
  responses: ReturnType<typeof jsonResponse>[],
  options: { readonly prompt?: string; readonly prices?: TokenPrices } = {},
) {
  const transport = createFakeTransport(responses);
  const notes: string[] = [];
  const provider = new KeyedProvider({
    connection: CONNECTION,
    model: "deepseek/deepseek-v4.1-flash",
    prompt: options.prompt ?? "print hi in the sandbox",
    client: new OpenAiCompatibleClient(CONNECTION, { transport }),
    ...(options.prices === undefined ? {} : { prices: options.prices }),
    note: (line) => notes.push(line),
  });
  return { provider, transport, notes };
}

const outcome = (patch: Partial<ToolOutcome> = {}): ToolOutcome => ({
  toolCallId: "call_1",
  toolName: "bash",
  ok: true,
  denied: false,
  output: "hi\n",
  durationMs: 12,
  ...patch,
});

describe("the keyed provider over a fake transport", () => {
  test("one real turn: the model's text and tool call reach the loop, and the request is journaled", async () => {
    const { provider, transport, notes } = providerWith([
      jsonResponse(
        200,
        completion({ role: "assistant", content: "Running it.", tool_calls: [CALL] }, "tool_calls"),
      ),
    ]);

    const turn = await provider.next({ turn: 1, tools: TOOLS, results: [] });

    expect(turn).toEqual({
      text: ["Running it."],
      toolCalls: [
        { toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" }, destructive: true },
      ],
    });

    const request = transport.requests[0];
    expect(request?.url).toBe("http://provider.test/v1/chat/completions");
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      stream: false,
      tool_choice: "auto",
      messages: [
        { role: "system", content: expect.stringContaining("sandboxed workspace") },
        { role: "user", content: "print hi in the sandbox" },
      ],
      tools: [{ type: "function", function: { name: "bash" } }],
    });

    expect(provider.journal).toEqual([
      {
        turn: 1,
        request: {
          method: "POST",
          url: "http://provider.test/v1/chat/completions",
          model: "deepseek/deepseek-v4.1-flash",
          messages: 2,
          tools: ["bash"],
          authorization: "Bearer <redacted>",
        },
        text: "Running it.",
        calls: [
          {
            toolCallId: "call_1",
            toolName: "bash",
            arguments: '{"command":"echo hi"}',
            repairs: [],
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 118, outputTokens: 23, totalTokens: 141 },
      },
    ]);
    expect(notes).toEqual([
      'freebot provider: turn 1 request POST http://provider.test/v1/chat/completions model=deepseek/deepseek-v4.1-flash messages=2 tools=bash authorization="Bearer <redacted>"',
      'freebot provider: turn 1 text "Running it."',
      'freebot provider: turn 1 tool_call call_1 bash {"command":"echo hi"}',
      "freebot provider: turn 1 done finish=tool_calls usage=118/23/141",
    ]);
  });

  test("a priced turn carries the nano-USD the run's spend cap compares", async () => {
    const { provider } = providerWith(
      [
        jsonResponse(
          200,
          completion(
            { role: "assistant", content: "Running it.", tool_calls: [CALL] },
            "tool_calls",
          ),
        ),
      ],
      {
        prices: {
          inputPerMTok: "3.00",
          outputPerMTok: "15.00",
          cacheReadPerMTok: "0.30",
          cacheWritePerMTok: "3.75",
        },
      },
    );
    const turn = await provider.next({ turn: 1, tools: TOOLS, results: [] });
    expect(turn.usage).toEqual({
      provider: "byok",
      model: "deepseek/deepseek-v4.1-flash",
      tokens: { input: 118, output: 23, cacheRead: 0, cacheWrite: 0 },
      // 118 x 3000 + 23 x 15000, in integer nano-USD.
      costNanoUsd: 699_000,
    });
  });

  test("an unpriced turn reports no cost rather than a zero a cap would read as satisfied", async () => {
    const { provider } = providerWith([
      jsonResponse(200, completion({ role: "assistant", content: "hi" })),
    ]);
    const turn = await provider.next({ turn: 1, tools: TOOLS, results: [] });
    expect(turn.usage).toBeUndefined();
  });

  test("the next turn carries the assistant's call and the tool's own output back to the model", async () => {
    const { provider, transport } = providerWith([
      jsonResponse(
        200,
        completion({ role: "assistant", content: "", tool_calls: [CALL] }, "tool_calls"),
      ),
      jsonResponse(200, completion({ role: "assistant", content: "It printed hi." })),
    ]);

    await provider.next({ turn: 1, tools: TOOLS, results: [] });
    const second = await provider.next({ turn: 2, tools: TOOLS, results: [outcome()] });

    expect(second).toEqual({ text: ["It printed hi."], toolCalls: [] });
    expect(JSON.parse(transport.requests[1]?.body ?? "{}")).toMatchObject({
      messages: [
        { role: "system" },
        { role: "user", content: "print hi in the sandbox" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function" }] },
        { role: "tool", tool_call_id: "call_1", content: "hi\n" },
      ],
    });
  });

  test("a denied call is told to the model as a refusal, so a retry is the model's own choice", () => {
    expect(
      outcomeText(
        outcome({ denied: true, ok: false, output: "the user denied action v1:sha256:ab" }),
      ),
    ).toBe("refused by the user: the user denied action v1:sha256:ab");
    expect(outcomeText(outcome({ ok: false, output: "exit 1" }))).toBe(
      "the command failed: exit 1",
    );
    expect(outcomeText(outcome({ output: "" }))).toBe("(the command produced no output)");
  });

  test("a tool the run does not offer is a malformed tool call, not a call the gate ever sees", async () => {
    const { provider } = providerWith([
      jsonResponse(
        200,
        completion({
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_9", type: "function", function: { name: "rm_rf", arguments: "{}" } },
          ],
        }),
      ),
    ]);

    const failure = await provider
      .next({ turn: 1, tools: TOOLS, results: [] })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderTurnError);
    expect((failure as ProviderTurnError).code).toBe("provider_malformed_tool_call");
    expect((failure as ProviderTurnError).detail).toContain('"rm_rf"');
  });

  test("the client's typed failures become the taxonomy codes the loop settles on", async () => {
    const auth = providerWith([jsonResponse(401, { error: { message: "bad key" } })]);
    const rate = providerWith([
      jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "30" }),
    ]);

    await expect(auth.provider.next({ turn: 1, tools: TOOLS, results: [] })).rejects.toMatchObject({
      code: "provider_auth",
      detail: "ProviderAuthError: auth rejected (401): bad key",
    });
    await expect(rate.provider.next({ turn: 1, tools: TOOLS, results: [] })).rejects.toMatchObject({
      code: "provider_rate_limit",
      detail: "ProviderRateLimitError: rate limited (429): slow down, retry after 30000ms",
    });
  });

  test("a provider that echoes the key cannot get it into a note, the journal, or a failure", async () => {
    const { provider, notes } = providerWith([
      jsonResponse(500, { error: { message: `the header was Bearer ${API_KEY}` } }),
    ]);

    const failure = await provider
      .next({ turn: 1, tools: TOOLS, results: [] })
      .then(() => null)
      .catch((error: unknown) => error);

    expect((failure as ProviderTurnError).detail).toContain("Bearer <redacted>");
    expect(JSON.stringify(provider.journal)).not.toContain(API_KEY);
    expect(notes.join("\n")).not.toContain(API_KEY);
  });

  test("a call's arguments are repaired visibly rather than silently when the model wraps them", async () => {
    const { provider, notes } = providerWith([
      jsonResponse(
        200,
        completion({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "bash", arguments: '```json\n{"command":"ls"}\n```' },
            },
          ],
        }),
      ),
    ]);

    const turn = await provider.next({ turn: 1, tools: TOOLS, results: [] });

    expect(turn.toolCalls[0]?.args).toEqual({ command: "ls" });
    expect(provider.journal[0]?.calls[0]?.repairs).toEqual(["markdown fence stripped"]);
    expect(notes.join("\n")).toContain('repairs=["markdown fence stripped"]');
  });
});
