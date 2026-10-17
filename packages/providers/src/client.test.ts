import { describe, expect, test } from "bun:test";
import {
  type ChatStreamEvent,
  OpenAiCompatibleClient,
  ProviderAuthError,
  ProviderHttpError,
  ProviderMalformedToolCallError,
  ProviderRateLimitError,
  ProviderRefusalError,
  ProviderTimeoutError,
  ProviderTransportError,
  parseToolCallArguments,
} from "./index.ts";
import { createFakeTransport, fetchTransport, jsonResponse, sseResponse } from "./transport.ts";

const CONNECTION = { baseUrl: "http://provider.test/v1", apiKey: "key-for-client-test" };

const completion = (message: Record<string, unknown>, finishReason = "stop") => ({
  id: "chatcmpl-1",
  choices: [{ index: 0, message, finish_reason: finishReason }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

describe("the OpenAI-compatible client", () => {
  test("a non-streaming completion returns text, tool calls with parsed arguments, and usage", async () => {
    const transport = createFakeTransport([
      jsonResponse(
        200,
        completion({
          role: "assistant",
          content: "calling the tool",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "freebot_smoke_echo", arguments: '{"text":"hi"}' },
            },
          ],
        }),
      ),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });

    const result = await client.chat({
      model: "some-model",
      messages: [{ role: "user", content: "echo hi" }],
      tools: [
        { name: "freebot_smoke_echo", description: "Echo text", parameters: { type: "object" } },
      ],
    });

    expect(result.text).toBe("calling the tool");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "freebot_smoke_echo",
        arguments: '{"text":"hi"}',
        args: { text: "hi" },
        repairs: [],
      },
    ]);

    const request = transport.requests[0];
    expect(request?.url).toBe("http://provider.test/v1/chat/completions");
    expect(request?.headers.authorization).toBe("Bearer key-for-client-test");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      model: "some-model",
      messages: [{ role: "user", content: "echo hi" }],
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "freebot_smoke_echo",
            description: "Echo text",
            parameters: { type: "object" },
          },
        },
      ],
    });
  });

  test("a trailing slash on the base URL does not double the path", async () => {
    const transport = createFakeTransport([jsonResponse(200, completion({ content: "ok" }))]);
    const client = new OpenAiCompatibleClient(
      { baseUrl: "http://provider.test/v1/", apiKey: "key-for-client-test" },
      { transport },
    );
    await client.chat({ model: "m", messages: [] });
    expect(transport.requests[0]?.url).toBe("http://provider.test/v1/chat/completions");
  });

  test("streaming assembles deltas split across chunks and completes with the same result", async () => {
    const transport = createFakeTransport([
      sseResponse(200, [
        { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "Calling " }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "freebot_smoke_echo", arguments: '{"te' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });

    const events: ChatStreamEvent[] = [];
    for await (const event of client.streamChat({ model: "m", messages: [] })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_call_delta",
      "tool_call_delta",
      "completed",
    ]);
    expect(events[0]).toEqual({ type: "text_delta", text: "Calling " });
    expect(events[1]).toEqual({
      type: "tool_call_delta",
      index: 0,
      id: "call_1",
      name: "freebot_smoke_echo",
      argumentsDelta: '{"te',
    });
    const completed = events[3];
    expect(completed?.type === "completed" && completed.result).toEqual({
      text: "Calling ",
      toolCalls: [
        {
          id: "call_1",
          name: "freebot_smoke_echo",
          arguments: '{"text":"hi"}',
          args: { text: "hi" },
          repairs: [],
        },
      ],
      finishReason: "tool_calls",
      usage: null,
    });
  });

  test("a streamed refusal delta is a typed refusal", async () => {
    const transport = createFakeTransport([
      sseResponse(200, [
        {
          choices: [
            { index: 0, delta: { refusal: "I cannot help with that." }, finish_reason: "stop" },
          ],
        },
      ]),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });
    const read = async () => {
      for await (const event of client.streamChat({ model: "m", messages: [] })) {
        void event;
      }
    };
    expect(read()).rejects.toBeInstanceOf(ProviderRefusalError);
  });
});

describe("the client's typed failures", () => {
  test("401 with the provider's message is an auth failure", async () => {
    const transport = createFakeTransport([
      jsonResponse(401, { error: { message: "Incorrect API key provided" } }),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });
    let caught: unknown;
    try {
      await client.chat({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderAuthError);
    const error = caught as ProviderAuthError;
    expect(error.status).toBe(401);
    expect(error.message).toBe("auth rejected (401): Incorrect API key provided");
  });

  test("429 carries the retry-after header in milliseconds", async () => {
    const transport = createFakeTransport([
      jsonResponse(429, { error: { message: "Rate limit reached" } }, { "retry-after": "2" }),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });
    let caught: unknown;
    try {
      await client.chat({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderRateLimitError);
    const error = caught as ProviderRateLimitError;
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(2000);
    expect(error.message).toBe("rate limited (429): Rate limit reached");
  });

  test("429 reads a body retry_after when no header came", async () => {
    const transport = createFakeTransport([
      jsonResponse(429, { error: { message: "slow down", retry_after: 3 } }),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });
    let caught: unknown;
    try {
      await client.chat({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect((caught as ProviderRateLimitError).retryAfterMs).toBe(3000);
  });

  test("a refusal on the message is a typed refusal, not empty text", async () => {
    const transport = createFakeTransport([
      jsonResponse(200, completion({ role: "assistant", content: null, refusal: "No." })),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });
    let caught: unknown;
    try {
      await client.chat({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderRefusalError);
    expect((caught as ProviderRefusalError).raw).toBe("No.");
  });

  test("a body that is not JSON is a transport failure, not a silent empty result", async () => {
    const transport = createFakeTransport([
      {
        status: 200,
        headers: {},
        body: new Response("not json").body as ReadableStream<Uint8Array>,
      },
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });
    expect(client.chat({ model: "m", messages: [] })).rejects.toBeInstanceOf(
      ProviderTransportError,
    );
  });

  test("a 500 is a typed http failure carrying the status", async () => {
    const transport = createFakeTransport([jsonResponse(500, { error: { message: "boom" } })]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });
    let caught: unknown;
    try {
      await client.chat({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderHttpError);
    expect((caught as ProviderHttpError).status).toBe(500);
  });

  test("a transport that never answers hits the deadline", async () => {
    const client = new OpenAiCompatibleClient(CONNECTION, {
      transport: { send: () => new Promise(() => {}) },
    });
    let caught: unknown;
    try {
      await client.chat({ model: "m", messages: [], timeoutMs: 20 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderTimeoutError);
    expect((caught as ProviderTimeoutError).timeoutMs).toBe(20);
  });

  test("a malformed tool call is a typed failure carrying the raw arguments", async () => {
    const transport = createFakeTransport([
      jsonResponse(
        200,
        completion({
          content: null,
          tool_calls: [
            { id: "call_9", function: { name: "freebot_smoke_echo", arguments: '{"text":"hi' } },
          ],
        }),
      ),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });
    let caught: unknown;
    try {
      await client.chat({ model: "m", messages: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderMalformedToolCallError);
    const error = caught as ProviderMalformedToolCallError;
    expect(error.toolName).toBe("freebot_smoke_echo");
    expect(error.rawArguments).toBe('{"text":"hi');
    expect(error.reason).toBe("arguments are an incomplete JSON object");
  });
});

describe("tool-call argument parsing", () => {
  test("the shapes weak callers produce", () => {
    expect(parseToolCallArguments('{"text":"hi"}')).toEqual({
      args: { text: "hi" },
      repairs: [],
    });
    expect(parseToolCallArguments("")).toEqual({
      args: {},
      repairs: ["absent arguments read as {}"],
    });
    expect(parseToolCallArguments(undefined)).toEqual({
      args: {},
      repairs: ["absent arguments read as {}"],
    });
    expect(parseToolCallArguments({ text: "hi" })).toEqual({
      args: { text: "hi" },
      repairs: ["arguments arrived as an object, not a string"],
    });
    expect(parseToolCallArguments('```json\n{"text":"hi"}\n```')).toEqual({
      args: { text: "hi" },
      repairs: ["markdown fence stripped"],
    });
    expect(parseToolCallArguments('Sure! {"text":"hi"}')).toEqual({
      args: { text: "hi" },
      repairs: ["surrounding text dropped, first JSON object kept"],
    });
    expect(parseToolCallArguments('{"a":1}{"b":2}')).toEqual({
      args: { a: 1 },
      repairs: ["surrounding text dropped, first JSON object kept"],
    });
    expect(parseToolCallArguments('{"text":"say \\"hi\\""}')).toEqual({
      args: { text: 'say "hi"' },
      repairs: [],
    });
  });

  test("the hopeless shapes fail with the text that arrived", () => {
    expect(() => parseToolCallArguments("[1,2]", "t")).toThrow(ProviderMalformedToolCallError);
    expect(() => parseToolCallArguments('{"text":"hi', "t")).toThrow(
      "malformed tool call for t: arguments are an incomplete JSON object",
    );
    expect(() => parseToolCallArguments(42, "t")).toThrow(
      "malformed tool call for t: arguments are neither a string nor an object: number",
    );
  });
});

describe("the fetch transport against a loopback server", () => {
  test("a fake provider on 127.0.0.1 is driven through the real transport", async () => {
    const seen: Array<{ auth: string | null; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.text();
        seen.push({ auth: request.headers.get("authorization"), body });
        const parsed = JSON.parse(body) as { stream: boolean };
        if (!parsed.stream) {
          return Response.json(
            completion({
              content: null,
              tool_calls: [
                {
                  id: "call_7",
                  function: { name: "freebot_smoke_echo", arguments: '{"text":"hi"}' },
                },
              ],
            }),
          );
        }
        return new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    try {
      const client = new OpenAiCompatibleClient(
        { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "key-for-client-test" },
        { transport: fetchTransport() },
      );
      const result = await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
      expect(result.toolCalls[0]?.args).toEqual({ text: "hi" });

      const streamed: string[] = [];
      for await (const event of client.streamChat({ model: "m", messages: [] })) {
        if (event.type === "text_delta") streamed.push(event.text);
      }
      expect(streamed).toEqual(["hi"]);

      expect(seen.length).toBe(2);
      expect(seen[0]?.auth).toBe("Bearer key-for-client-test");
      expect(JSON.parse(seen[0]?.body ?? "{}").stream).toBe(false);
      expect(JSON.parse(seen[1]?.body ?? "{}").stream).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
