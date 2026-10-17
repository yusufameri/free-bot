/**
 * The literal cases the providers artifact carries: malformed tool-call shapes, client error
 * shapes, and the structured fallback's success and failure literals.
 *
 * Every case runs the shipped code against a scripted transport. No case reaches a network, and no
 * case carries a key value.
 */

import type { ToolSpec } from "../src/client.ts";
import { parseStructuredReply, runStructuredToolTurn } from "../src/fallback.ts";
import {
  type ChatStreamEvent,
  classifyStatus,
  OpenAiCompatibleClient,
  ProviderAuthError,
  ProviderHttpError,
  ProviderMalformedToolCallError,
  ProviderRateLimitError,
  ProviderRefusalError,
  ProviderTimeoutError,
  ProviderTransportError,
  parseToolCallArguments,
} from "../src/index.ts";
import { createFakeTransport, jsonResponse, sseResponse } from "../src/transport.ts";

export interface CaseRow {
  label: string;
  line: string;
  ok: boolean;
}

const CONNECTION = { baseUrl: "http://provider.test/v1", apiKey: "key-for-provider-cases" };

const ECHO: ToolSpec = {
  name: "freebot_smoke_echo",
  description: "Echo text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

const completion = (message: Record<string, unknown>, finishReason = "stop") => ({
  choices: [{ index: 0, message, finish_reason: finishReason }],
});

/** How a caught error reads in the artifact: type, the fields a caller acts on, no headers. */
function describeError(error: unknown): string {
  if (error instanceof ProviderAuthError)
    return `ProviderAuthError status=${error.status} detail=${error.message}`;
  if (error instanceof ProviderRateLimitError) {
    return `ProviderRateLimitError status=${error.status} retryAfterMs=${error.retryAfterMs} detail=${error.message}`;
  }
  if (error instanceof ProviderRefusalError) {
    return `ProviderRefusalError finishReason=${error.finishReason} raw=${JSON.stringify(error.raw)}`;
  }
  if (error instanceof ProviderMalformedToolCallError) {
    return `ProviderMalformedToolCallError toolName=${error.toolName} reason=${JSON.stringify(error.reason)} rawArguments=${JSON.stringify(error.rawArguments)}`;
  }
  if (error instanceof ProviderTimeoutError)
    return `ProviderTimeoutError timeoutMs=${error.timeoutMs}`;
  if (error instanceof ProviderHttpError)
    return `ProviderHttpError status=${error.status} body=${JSON.stringify(error.body)}`;
  if (error instanceof ProviderTransportError)
    return `ProviderTransportError detail=${error.message}`;
  return `${error instanceof Error ? error.name : typeof error}: ${error instanceof Error ? error.message : String(error)}`;
}

// ---------------------------------------------------------------------------
// Malformed tool-call shapes
// ---------------------------------------------------------------------------

/** `read` means the arguments must come back as an object; `fail` means a typed error must. */
const ARGUMENT_SHAPES: ReadonlyArray<{ label: string; raw: unknown; expect: "read" | "fail" }> = [
  { label: "well-formed object", raw: '{"text":"hi"}', expect: "read" },
  { label: "arguments arrive as an object", raw: { text: "hi" }, expect: "read" },
  { label: "absent arguments", raw: undefined, expect: "read" },
  { label: "blank arguments", raw: "", expect: "read" },
  { label: "fenced object", raw: '```json\n{"text":"hi"}\n```', expect: "read" },
  { label: "prose before the object", raw: 'Sure, calling it now: {"text":"hi"}', expect: "read" },
  { label: "two objects back to back", raw: '{"a":1}{"b":2}', expect: "read" },
  { label: "escaped quotes inside a string", raw: '{"text":"say \\"hi\\""}', expect: "read" },
  { label: "trailing comma", raw: '{"text":"hi",}', expect: "fail" },
  { label: "bare array", raw: "[1,2]", expect: "fail" },
  { label: "truncated object", raw: '{"text":"hi', expect: "fail" },
  { label: "no JSON at all", raw: "text=hi", expect: "fail" },
  { label: "a number", raw: 42, expect: "fail" },
];

export function malformedToolCallCases(): CaseRow[] {
  return ARGUMENT_SHAPES.map((shape) => {
    const label = `arguments: ${shape.label}`;
    let line: string;
    let threw: boolean;
    try {
      const parsed = parseToolCallArguments(shape.raw, ECHO.name);
      const repairs = parsed.repairs.length === 0 ? "[]" : `[${parsed.repairs.join("; ")}]`;
      line = `${label} -> args=${JSON.stringify(parsed.args)} repairs=${repairs}`;
      threw = false;
    } catch (error) {
      line = `${label} -> ${describeError(error)}`;
      threw = true;
    }
    return { label, line, ok: threw === (shape.expect === "fail") };
  });
}

// ---------------------------------------------------------------------------
// Client error shapes
// ---------------------------------------------------------------------------

async function chatOutcome(
  script: Parameters<typeof createFakeTransport>[0],
  timeoutMs = 1000,
): Promise<string> {
  const client = new OpenAiCompatibleClient(CONNECTION, { transport: createFakeTransport(script) });
  try {
    const result = await client.chat({
      model: "some-model",
      messages: [{ role: "user", content: "hi" }],
      ...(timeoutMs === 1000 ? {} : { timeoutMs }),
    });
    return `no error, text=${JSON.stringify(result.text)} toolCalls=${result.toolCalls.length}`;
  } catch (error) {
    return describeError(error);
  }
}

export async function errorShapeCases(): Promise<CaseRow[]> {
  const rows: CaseRow[] = [];
  const push = async (label: string, outcome: Promise<string>): Promise<void> => {
    const line = await outcome;
    rows.push({ label, line: `error: ${label} -> ${line}`, ok: true });
  };

  await push(
    "401 credential rejected",
    chatOutcome([jsonResponse(401, { error: { message: "Incorrect API key provided" } })]),
  );
  await push(
    "403 forbidden",
    chatOutcome([jsonResponse(403, { error: { message: "Project is disabled" } })]),
  );
  await push(
    "429 with a retry-after header",
    chatOutcome([
      jsonResponse(429, { error: { message: "Rate limit reached" } }, { "retry-after": "2" }),
    ]),
  );
  await push(
    "429 with a body retry_after",
    chatOutcome([jsonResponse(429, { error: { message: "slow down", retry_after: 3 } })]),
  );
  await push("500 without a message", chatOutcome([jsonResponse(500, { error: {} })]));
  await push(
    "refusal on the message",
    chatOutcome([jsonResponse(200, completion({ content: null, refusal: "I cannot help." }))]),
  );
  await push(
    "refusal by finish_reason",
    chatOutcome([jsonResponse(200, completion({ content: "blocked" }, "content_filter"))]),
  );
  await push(
    "malformed tool call",
    chatOutcome([
      jsonResponse(
        200,
        completion({
          content: null,
          tool_calls: [{ id: "call_9", function: { name: ECHO.name, arguments: '{"text":"hi' } }],
        }),
      ),
    ]),
  );
  await push(
    "a body that is not JSON",
    chatOutcome([
      {
        status: 200,
        headers: {},
        body: new Response("gateway timeout").body as ReadableStream<Uint8Array>,
      },
    ]),
  );
  await push(
    "a stream whose argument deltas never form JSON",
    (async () => {
      const client = new OpenAiCompatibleClient(CONNECTION, {
        transport: createFakeTransport([
          sseResponse(200, [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: { name: ECHO.name, arguments: '{"text":' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]),
        ]),
      });
      try {
        for await (const event of client.streamChat({ model: "some-model", messages: [] })) {
          void (event as ChatStreamEvent);
        }
        return "no error";
      } catch (error) {
        return describeError(error);
      }
    })(),
  );

  const hanging = new OpenAiCompatibleClient(CONNECTION, {
    transport: { send: () => new Promise(() => {}) },
  });
  try {
    await hanging.chat({ model: "some-model", messages: [], timeoutMs: 20 });
    rows.push({ label: "deadline", line: "error: deadline -> no error", ok: false });
  } catch (error) {
    rows.push({ label: "deadline", line: `error: deadline -> ${describeError(error)}`, ok: true });
  }
  return rows;
}

/** The status mapping on its own, for the shapes a scripted transport cannot reach. */
export function statusCases(): CaseRow[] {
  return [400, 401, 403, 404, 429, 500, 503].map((status) => ({
    label: `status ${status}`,
    line: `status ${status} -> ${classifyStatus(status, '{"error":{"message":"m"}}').name}`,
    ok: true,
  }));
}

// ---------------------------------------------------------------------------
// The structured fallback
// ---------------------------------------------------------------------------

const REPLIES: ReadonlyArray<{ label: string; content: string }> = [
  {
    label: "bare JSON tool call",
    content: '{"tool":"freebot_smoke_echo","arguments":{"text":"hi"}}',
  },
  {
    label: "fenced JSON with prose around it",
    content: 'Sure:\n```json\n{"tool":"freebot_smoke_echo","arguments":{"text":"hi"}}\n```\nDone.',
  },
  {
    label: "the {name, arguments} spelling",
    content: '{"name":"freebot_smoke_echo","arguments":{"text":"hi"}}',
  },
  { label: "tool null with text", content: '{"tool":null,"text":"nothing to do"}' },
  { label: "prose only", content: "Nope, I only chat." },
  {
    label: "truncated JSON",
    content: '{"tool":"freebot_smoke_echo","arguments":{"text":"hi"',
  },
  { label: "JSON with no tool key", content: '{"text":"hi"}' },
  {
    label: "arguments as a string, not an object",
    content: '{"tool":"freebot_smoke_echo","arguments":"hi"}',
  },
];

export async function fallbackCases(): Promise<CaseRow[]> {
  const rows: CaseRow[] = [];
  for (const reply of REPLIES) {
    const client = new OpenAiCompatibleClient(CONNECTION, {
      transport: createFakeTransport([jsonResponse(200, completion({ content: reply.content }))]),
    });
    const outcome = await runStructuredToolTurn(client, {
      model: "weak-model",
      task: "Echo hi",
      tools: [ECHO],
    });
    const label = `fallback: ${reply.label}`;
    if (outcome.reply.kind === "tool_call") {
      const repairs =
        outcome.reply.repairs.length === 0 ? "" : ` repairs=[${outcome.reply.repairs.join("; ")}]`;
      rows.push({
        label,
        line: `${label} -> tool_call ${outcome.reply.name} args=${JSON.stringify(outcome.reply.args)}${repairs}`,
        ok: true,
      });
    } else if (outcome.reply.kind === "text") {
      rows.push({
        label,
        line: `${label} -> text ${JSON.stringify(outcome.reply.text)} (no tool needed)`,
        ok: true,
      });
    } else {
      rows.push({
        label,
        line: `${label} -> failed reason=${JSON.stringify(outcome.reply.reason)} raw=${JSON.stringify(outcome.reply.raw)}`,
        ok: outcome.failure?.reason === outcome.reply.reason,
      });
    }
  }

  // The parser alone, so the artifact shows the reply text next to the reading of it.
  for (const reply of REPLIES) {
    const parsed = parseStructuredReply(reply.content);
    rows.push({
      label: `parse: ${reply.label}`,
      line: `parse ${JSON.stringify(reply.content)} -> ${parsed.kind}`,
      ok: true,
    });
  }
  return rows;
}
