/**
 * The literal cases the providers artifact carries: malformed tool-call shapes, client error
 * shapes, and the structured fallback's success and failure literals.
 *
 * Every case runs the shipped code against a scripted transport. No case reaches a network, and no
 * case carries a key value. Every row asserts the literal it prints against an expectation, so a
 * regression fails the run instead of printing PASS.
 */

import type { ToolSpec } from "../src/client.ts";
import {
  parseStructuredReply,
  runStructuredToolTurn,
  type StructuredReply,
} from "../src/fallback.ts";
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
  // The expectation is the error type plus the fields a caller acts on. The detail text stays out of
  // it: that text carries the provider's own wording and the runtime's parse message.
  const push = async (label: string, outcome: Promise<string>, expect: string): Promise<void> => {
    const actual = await outcome;
    rows.push({ label, line: `error: ${label} -> ${actual}`, ok: actual.startsWith(expect) });
  };

  await push(
    "401 credential rejected",
    chatOutcome([jsonResponse(401, { error: { message: "Incorrect API key provided" } })]),
    "ProviderAuthError status=401",
  );
  await push(
    "403 forbidden",
    chatOutcome([jsonResponse(403, { error: { message: "Project is disabled" } })]),
    "ProviderAuthError status=403",
  );
  await push(
    "429 with a retry-after header",
    chatOutcome([
      jsonResponse(429, { error: { message: "Rate limit reached" } }, { "retry-after": "2" }),
    ]),
    "ProviderRateLimitError status=429 retryAfterMs=2000",
  );
  await push(
    "429 with a body retry_after",
    chatOutcome([jsonResponse(429, { error: { message: "slow down", retry_after: 3 } })]),
    "ProviderRateLimitError status=429 retryAfterMs=3000",
  );
  await push(
    "500 without a message",
    chatOutcome([jsonResponse(500, { error: {} })]),
    "ProviderHttpError status=500",
  );
  await push(
    "refusal on the message",
    chatOutcome([jsonResponse(200, completion({ content: null, refusal: "I cannot help." }))]),
    "ProviderRefusalError finishReason=stop",
  );
  await push(
    "refusal by finish_reason",
    chatOutcome([jsonResponse(200, completion({ content: "blocked" }, "content_filter"))]),
    "ProviderRefusalError finishReason=content_filter",
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
    `ProviderMalformedToolCallError toolName=${ECHO.name}`,
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
    "ProviderTransportError",
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
    `ProviderMalformedToolCallError toolName=${ECHO.name}`,
  );
  await push(
    "deadline",
    (async () => {
      const hanging = new OpenAiCompatibleClient(CONNECTION, {
        transport: { send: () => new Promise(() => {}) },
      });
      try {
        await hanging.chat({ model: "some-model", messages: [], timeoutMs: 20 });
        return "no error";
      } catch (error) {
        return describeError(error);
      }
    })(),
    "ProviderTimeoutError timeoutMs=20",
  );
  return rows;
}

/** The class each status must map onto, which is the literal the artifact line is asserted against. */
const STATUS_MAPPINGS: ReadonlyArray<{
  status: number;
  expect: new (...args: never[]) => Error;
}> = [
  { status: 400, expect: ProviderHttpError },
  { status: 401, expect: ProviderAuthError },
  { status: 403, expect: ProviderAuthError },
  { status: 404, expect: ProviderHttpError },
  { status: 429, expect: ProviderRateLimitError },
  { status: 500, expect: ProviderHttpError },
  { status: 503, expect: ProviderHttpError },
];

/** The status mapping on its own, for the shapes a scripted transport cannot reach. */
export function statusCases(): CaseRow[] {
  return STATUS_MAPPINGS.map(({ status, expect }) => {
    const mapped = classifyStatus(status, '{"error":{"message":"m"}}');
    return {
      label: `status ${status}`,
      line: `status ${status} -> ${mapped.name}`,
      ok: mapped instanceof expect,
    };
  });
}

// ---------------------------------------------------------------------------
// The structured fallback
// ---------------------------------------------------------------------------

const REPLIES: ReadonlyArray<{
  label: string;
  content: string;
  /** The reading this reply must get, asserted on both rows below. */
  kind: StructuredReply["kind"];
  /** The outcome prefix the fallback turn must print: repairs and raw text follow it. */
  expect: string;
}> = [
  {
    label: "bare JSON tool call",
    content: '{"tool":"freebot_smoke_echo","arguments":{"text":"hi"}}',
    kind: "tool_call",
    expect: 'tool_call freebot_smoke_echo args={"text":"hi"}',
  },
  {
    label: "fenced JSON with prose around it",
    content: 'Sure:\n```json\n{"tool":"freebot_smoke_echo","arguments":{"text":"hi"}}\n```\nDone.',
    kind: "tool_call",
    expect: 'tool_call freebot_smoke_echo args={"text":"hi"}',
  },
  {
    label: "the {name, arguments} spelling",
    content: '{"name":"freebot_smoke_echo","arguments":{"text":"hi"}}',
    kind: "tool_call",
    expect: 'tool_call freebot_smoke_echo args={"text":"hi"}',
  },
  {
    label: "tool null with text",
    content: '{"tool":null,"text":"nothing to do"}',
    kind: "text",
    expect: 'text "nothing to do"',
  },
  {
    label: "prose only",
    content: "Nope, I only chat.",
    kind: "invalid",
    expect: 'failed reason="no JSON object in the reply"',
  },
  {
    label: "truncated JSON",
    content: '{"tool":"freebot_smoke_echo","arguments":{"text":"hi"',
    kind: "invalid",
    expect: 'failed reason="the reply\'s JSON object is incomplete"',
  },
  {
    label: "JSON with no tool key",
    content: '{"text":"hi"}',
    kind: "invalid",
    expect: 'failed reason="the JSON object carried no tool key"',
  },
  {
    label: "arguments as a string, not an object",
    content: '{"tool":"freebot_smoke_echo","arguments":"hi"}',
    kind: "invalid",
    expect: 'failed reason="the tool arguments did not parse:',
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
    let produced: string;
    if (outcome.reply.kind === "tool_call") {
      const repairs =
        outcome.reply.repairs.length === 0 ? "" : ` repairs=[${outcome.reply.repairs.join("; ")}]`;
      produced = `tool_call ${outcome.reply.name} args=${JSON.stringify(outcome.reply.args)}${repairs}`;
    } else if (outcome.reply.kind === "text") {
      produced = `text ${JSON.stringify(outcome.reply.text)} (no tool needed)`;
    } else {
      produced = `failed reason=${JSON.stringify(outcome.reply.reason)} raw=${JSON.stringify(outcome.reply.raw)}`;
    }
    // A failure means the recorded failure mode names the same reason; a success records none.
    const failureRecorded =
      outcome.reply.kind === "invalid"
        ? outcome.failure?.reason === outcome.reply.reason
        : outcome.failure === null;
    rows.push({
      label,
      line: `${label} -> ${produced}`,
      ok: outcome.reply.kind === reply.kind && produced.startsWith(reply.expect) && failureRecorded,
    });
  }

  // The parser alone, so the artifact shows the reply text next to the reading of it.
  for (const reply of REPLIES) {
    const parsed = parseStructuredReply(reply.content);
    rows.push({
      label: `parse: ${reply.label}`,
      line: `parse ${JSON.stringify(reply.content)} -> ${parsed.kind}`,
      ok: parsed.kind === reply.kind,
    });
  }
  return rows;
}
