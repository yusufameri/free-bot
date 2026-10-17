import { describe, expect, test } from "bun:test";
import type { ToolSpec } from "./client.ts";
import { OpenAiCompatibleClient } from "./client.ts";
import {
  parseStructuredReply,
  runStructuredToolTurn,
  STRUCTURED_TOOL_INSTRUCTION,
  structuredToolMessages,
} from "./fallback.ts";
import { createFakeTransport, jsonResponse } from "./transport.ts";

const CONNECTION = { baseUrl: "http://provider.test/v1", apiKey: "key-for-fallback-test" };

const ECHO: ToolSpec = {
  name: "freebot_smoke_echo",
  description: "Echo text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

const reply = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
});

describe("the structured-output prompt", () => {
  test("it names the exact JSON shape and carries the tool specs and the task", () => {
    const messages = structuredToolMessages([ECHO], "Echo hi");
    expect(messages[0]).toEqual({ role: "system", content: STRUCTURED_TOOL_INSTRUCTION });
    const user = messages[1]?.content ?? "";
    expect(user).toContain('"name": "freebot_smoke_echo"');
    expect(user).toContain('"description": "Echo text back."');
    expect(user).toContain('"required"');
    expect(user.endsWith("Task: Echo hi")).toBe(true);
    expect(STRUCTURED_TOOL_INSTRUCTION).toBe(
      "Reply with exactly one JSON object and nothing else. " +
        'To call a tool, use {"tool": "<name>", "arguments": {<arguments>}}. ' +
        'If no tool is needed, use {"tool": null, "text": "<your answer>"}.',
    );
  });
});

describe("the structured reply parser", () => {
  test("a bare tool call", () => {
    expect(parseStructuredReply('{"tool":"freebot_smoke_echo","arguments":{"text":"hi"}}')).toEqual(
      {
        kind: "tool_call",
        name: "freebot_smoke_echo",
        arguments: '{"text":"hi"}',
        args: { text: "hi" },
        repairs: [],
      },
    );
  });

  test("a fenced reply with prose around it", () => {
    const raw =
      'Sure, here it is:\n```json\n{"tool": "freebot_smoke_echo", "arguments": {"text": "hi"}}\n```\nDone.';
    const parsed = parseStructuredReply(raw);
    expect(parsed.kind).toBe("tool_call");
    expect(parsed.kind === "tool_call" && parsed.args).toEqual({ text: "hi" });
    expect(parsed.kind === "tool_call" && parsed.repairs).toContain(
      "surrounding text dropped, first JSON object kept",
    );
  });

  test("the {name, arguments} spelling a weak caller invents", () => {
    const parsed = parseStructuredReply('{"name":"freebot_smoke_echo","arguments":{"text":"hi"}}');
    expect(parsed.kind).toBe("tool_call");
    expect(parsed.kind === "tool_call" && parsed.repairs).toEqual([
      "read {name, arguments} instead of {tool, arguments}",
    ]);
  });

  test("a null tool is the model saying no tool is needed", () => {
    expect(parseStructuredReply('{"tool":null,"text":"nothing to do"}')).toEqual({
      kind: "text",
      text: "nothing to do",
      repairs: [],
    });
  });

  test("prose with no JSON is invalid, and the raw reply comes back with it", () => {
    expect(parseStructuredReply("I cannot do that.")).toEqual({
      kind: "invalid",
      reason: "no JSON object in the reply",
      raw: "I cannot do that.",
    });
    const truncated = parseStructuredReply('{"tool":"freebot_smoke_echo","arguments":{"text":"hi"');
    expect(truncated.kind).toBe("invalid");
    expect(truncated).toEqual({
      kind: "invalid",
      reason: "the reply's JSON object is incomplete",
      raw: '{"tool":"freebot_smoke_echo","arguments":{"text":"hi"',
    });
  });

  test("an object with no tool key is invalid rather than an empty call", () => {
    expect(parseStructuredReply('{"text":"hi"}')).toEqual({
      kind: "invalid",
      reason: "the JSON object carried no tool key",
      raw: '{"text":"hi"}',
    });
  });
});

describe("one fallback turn", () => {
  test("a JSON tool-call reply becomes the tool call, with response_format on the wire", async () => {
    const transport = createFakeTransport([
      jsonResponse(
        200,
        reply('```json\n{"tool":"freebot_smoke_echo","arguments":{"text":"hi"}}\n```'),
      ),
    ]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });

    const outcome = await runStructuredToolTurn(client, {
      model: "weak-model",
      task: "Echo hi",
      tools: [ECHO],
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.reply.kind).toBe("tool_call");
    expect(outcome.reply.kind === "tool_call" && outcome.reply.name).toBe("freebot_smoke_echo");
    expect(outcome.reply.kind === "tool_call" && outcome.reply.args).toEqual({ text: "hi" });
    expect(JSON.parse(transport.requests[0]?.body ?? "{}").response_format).toEqual({
      type: "json_object",
    });
  });

  test("even the fallback failing is recorded, not swallowed", async () => {
    const transport = createFakeTransport([jsonResponse(200, reply("Nope, I only chat."))]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });

    const outcome = await runStructuredToolTurn(client, {
      model: "weak-model",
      task: "Echo hi",
      tools: [ECHO],
    });

    expect(outcome.reply.kind).toBe("invalid");
    expect(outcome.failure).toEqual({
      reason: "no JSON object in the reply",
      raw: "Nope, I only chat.",
    });
  });

  test("a JSON reply with no tool key is a recorded failure mode too", async () => {
    const transport = createFakeTransport([jsonResponse(200, reply('{"text":"hi"}'))]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });

    const outcome = await runStructuredToolTurn(client, {
      model: "weak-model",
      task: "Echo hi",
      tools: [ECHO],
    });

    expect(outcome.failure).toEqual({
      reason: "the JSON object carried no tool key",
      raw: '{"text":"hi"}',
    });
  });

  test("the client's own failure is the recorded failure mode", async () => {
    const transport = createFakeTransport([jsonResponse(401, { error: { message: "no key" } })]);
    const client = new OpenAiCompatibleClient(CONNECTION, { transport });

    const outcome = await runStructuredToolTurn(client, {
      model: "weak-model",
      task: "Echo hi",
      tools: [ECHO],
    });

    expect(outcome.failure?.reason).toBe("auth rejected (401): no key");
    expect(outcome.reply.kind).toBe("invalid");
  });
});
