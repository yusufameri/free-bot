/**
 * The capability test over a scripted wire: what the flags say for a native call, a reply without
 * one, a whole-reply endpoint, and a refusal.
 *
 * Every case asserts a literal from `packages/providers/src/capability.ts`, so a regression fails
 * here rather than printing a passing line. No case touches a network (order 9).
 */

import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_TEXT,
  CAPABILITY_TOOL,
  type CapabilityTestOptions,
  OpenAiCompatibleClient,
  ProviderAuthError,
  runCapabilityTest,
} from "./index.ts";
import { createFakeTransport, jsonResponse, sseResponse } from "./transport.ts";

const CONNECTION = { baseUrl: "http://provider.test/v1", apiKey: "key-for-capability-test" };

/** One whole completion body, for the non-streaming requests the test can make. */
const completion = (content: string, toolCalls: unknown[] = []) => ({
  id: "chatcmpl-cap",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content, ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }) },
      finish_reason: toolCalls.length === 0 ? "stop" : "tool_calls",
    },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
});

const callDelta = (name: string, args: string) => ({
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] },
      finish_reason: null,
    },
  ],
});

const textDeltas = (text: string) => [
  { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

function clientFor(script: Parameters<typeof createFakeTransport>[0]): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient(CONNECTION, { transport: createFakeTransport(script) });
}

function optionsFor(client: OpenAiCompatibleClient): CapabilityTestOptions {
  return {
    baseUrl: CONNECTION.baseUrl,
    model: "byok-model",
    apiKey: CONNECTION.apiKey,
    client,
  };
}

describe("the capability test", () => {
  test("a native tool call marks the connection strong and its closing reply is the answer", async () => {
    const client = clientFor([
      sseResponse(200, [callDelta(CAPABILITY_TOOL.name, `{"text":"${CAPABILITY_TEXT}"}`)]),
      sseResponse(200, textDeltas(CAPABILITY_TEXT)),
    ]);

    const turn = await runCapabilityTest(optionsFor(client));

    expect(turn.flags.toolCalling).toBe("strong");
    expect(turn.flags.streaming).toBe(true);
    expect(turn.flags.structuredOutput).toBeNull();
    expect(turn.answer).toBe(CAPABILITY_TEXT);
    expect(turn.toolNames).toEqual([CAPABILITY_TOOL.name]);
    expect(turn.requests).toBe(2);
    expect(turn.observation.executions).toEqual([
      { toolName: CAPABILITY_TOOL.name, isError: false },
    ]);
    expect(turn.flags.notes).toContain(`native tool call(s): ${CAPABILITY_TOOL.name}`);
  });

  test("the request carries the tool definition and the tool's own result goes back", async () => {
    const transport = createFakeTransport([
      sseResponse(200, [callDelta(CAPABILITY_TOOL.name, `{"text":"${CAPABILITY_TEXT}"}`)]),
      sseResponse(200, textDeltas(CAPABILITY_TEXT)),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });

    await runCapabilityTest(optionsFor(client));

    const first = JSON.parse(transport.requests[0]?.body ?? "{}") as {
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: string;
      stream?: boolean;
    };
    expect(first.tools?.map((tool) => tool.function.name)).toEqual([CAPABILITY_TOOL.name]);
    expect(first.tool_choice).toBe("auto");
    expect(first.stream).toBe(true);

    const second = JSON.parse(transport.requests[1]?.body ?? "{}") as {
      messages: Array<{ role: string; content: string | null }>;
    };
    expect(second.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(second.messages.at(-1)?.content).toBe(CAPABILITY_TEXT);
  });

  test("a reply with no tool call falls back to structured output and marks the connection weak", async () => {
    const client = clientFor([
      sseResponse(200, textDeltas("I cannot call tools.")),
      jsonResponse(
        200,
        completion(
          JSON.stringify({ tool: CAPABILITY_TOOL.name, arguments: { text: CAPABILITY_TEXT } }),
        ),
      ),
    ]);

    const turn = await runCapabilityTest(optionsFor(client));

    expect(turn.flags.toolCalling).toBe("weak");
    expect(turn.flags.structuredOutput).toBe(true);
    expect(turn.structured).toEqual({ parsableJson: true, toolCall: true });
    expect(turn.answer).toBe("I cannot call tools.");
    expect(turn.toolNames).toEqual([]);
    expect(turn.requests).toBe(2);
  });

  test("an endpoint that answers whole replies reports streaming unknown, not false", async () => {
    const refusesToStream = () => jsonResponse(400, { error: { message: "stream is not supported" } });
    const client = clientFor([
      refusesToStream(),
      jsonResponse(
        200,
        completion("", [
          {
            id: "call_1",
            type: "function",
            function: { name: CAPABILITY_TOOL.name, arguments: `{"text":"${CAPABILITY_TEXT}"}` },
          },
        ]),
      ),
      refusesToStream(),
      jsonResponse(200, completion(CAPABILITY_TEXT)),
    ]);

    const turn = await runCapabilityTest(optionsFor(client));

    expect(turn.flags.toolCalling).toBe("strong");
    expect(turn.flags.streaming).toBeNull();
    expect(turn.flags.notes).toContain(
      "streaming unknown: the endpoint answered whole replies",
    );
    expect(turn.answer).toBe(CAPABILITY_TEXT);
  });

  test("a refused credential comes back as the client's typed auth error, with its status", async () => {
    const client = clientFor([jsonResponse(401, { error: { message: "invalid api key" } })]);

    let thrown: unknown = null;
    try {
      await runCapabilityTest(optionsFor(client));
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof ProviderAuthError).toBe(true);
    expect((thrown as ProviderAuthError).status).toBe(401);
    expect((thrown as ProviderAuthError).message).toBe(
      "auth rejected (401): invalid api key",
    );
  });
});
