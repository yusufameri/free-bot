/**
 * The capability test page 1 runs: one real request carrying a tool definition, and the flags the
 * reply produced.
 *
 * This is the save-time smoke's own logic, over the client the run path uses rather than over Pi:
 * the same instruction, the same tool, the same observation shape, and the same `deriveFlags` call
 * that reads the observed turn. Reading flags off a model's name is what this module exists to
 * avoid, so a connection is `strong` because a call arrived and not because the id looks modern.
 *
 * Two requests happen when the model calls the tool, because the closing reply is only observable
 * after the result is handed back: one request with the tool definition, then one carrying the
 * tool's own result. A model that calls nothing is offered the structured-output fallback instead,
 * which is how a weaker connection still gets a tool call out of `{tool, arguments}`.
 *
 * The key reaches one `Authorization` header. Nothing here returns it, logs it, or puts it in the
 * observation.
 */

import {
  type ChatMessage,
  type ChatResult,
  type ChatStreamEvent,
  OpenAiCompatibleClient,
  type ToolSpec,
} from "./client.ts";
import { ProviderHttpError, ProviderTransportError } from "./errors.ts";
import { runStructuredToolTurn } from "./fallback.ts";
import {
  type CapabilityFlags,
  deriveFlags,
  type StructuredObservation,
  type TurnObservation,
} from "./flags.ts";

/** The tool the test asks for. Its name is the one the committed Pi smoke also uses. */
export const CAPABILITY_TOOL: ToolSpec = {
  name: "freebot_smoke_echo",
  description: "Echo text back.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

/** The text the test asks the model to echo, so the tool result is a literal a reader can check. */
export const CAPABILITY_TEXT = "save-time-smoke";

export const CAPABILITY_PROMPT =
  `Call the ${CAPABILITY_TOOL.name} tool exactly once with text "${CAPABILITY_TEXT}". ` +
  "After the tool result arrives, reply with the exact text it returned.";

/** What the test's own turn did, as a reader can check it without re-running it. */
export interface CapabilityTurn {
  /** The flags the observed turn produced, never derived from the model's name. */
  readonly flags: CapabilityFlags;
  readonly observation: TurnObservation;
  /** The structured-output observation, or null when that path was not exercised. */
  readonly structured: StructuredObservation | null;
  /** The model's own reply from the test: its closing text, or its only text. */
  readonly answer: string;
  /** The tools the model called, in order. Empty when it called none. */
  readonly toolNames: readonly string[];
  /** The tool definitions the request carried, so a reader can see it carried one. */
  readonly offered: readonly string[];
  /** How many requests the test made. */
  readonly requests: number;
}

export interface CapabilityTestOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  /** Injectable so a test drives a scripted wire with no network (order 9). */
  readonly client?: OpenAiCompatibleClient;
}

/** The deltas one turn delivered, accumulated across its requests. */
interface Deltas {
  text: number;
  toolCalls: number;
}

/** One request's reply, narrowed to what the observation reads. */
interface TurnReply {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

/** One reply's reply, with the increments it delivered counted into `deltas`. */
async function consume(
  events: AsyncGenerator<ChatStreamEvent>,
  deltas: Deltas,
): Promise<TurnReply> {
  let completed: ChatResult | null = null;
  for await (const event of events) {
    if (event.type === "text_delta") deltas.text += 1;
    else if (event.type === "tool_call_delta") deltas.toolCalls += 1;
    else completed = event.result;
  }
  if (completed === null) throw new ProviderTransportError("the reply carried no completion");
  return {
    text: completed.text,
    toolCalls: completed.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
  };
}
interface OneRequest {
  readonly reply: TurnReply;
  /** False when this request was answered whole, so its message never arrived in pieces. */
  readonly streamed: boolean;
}

/**
 * One request carrying a tool definition, and the deltas it delivered. Streaming is asked for
 * because the `streaming` flag is exactly "did increments arrive", which a non-streaming request
 * could not answer.
 *
 * An endpoint that will not stream is not a broken connection. Such an endpoint answers a streamed
 * request with a whole body and no SSE records, which the client reads as an empty reply: that is
 * caught here and the request is made again without streaming. The turn then says `streaming` is
 * unknown rather than the `false` the connection never earned, and the reply's own text and calls
 * are read from the second request instead of being lost. A credential or rate-limit refusal is not
 * one of these failures and never falls back.
 */
async function oneRequest(
  client: OpenAiCompatibleClient,
  options: {
    model: string;
    messages: readonly ChatMessage[];
    deltas: Deltas;
    timeoutMs?: number;
  },
): Promise<OneRequest> {
  try {
    const before = { text: options.deltas.text, toolCalls: options.deltas.toolCalls };
    const reply = await consume(
      client.streamChat({
        model: options.model,
        messages: options.messages,
        tools: [CAPABILITY_TOOL],
        toolChoice: "auto",
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
      options.deltas,
    );
    const incremented =
      options.deltas.text > before.text || options.deltas.toolCalls > before.toolCalls;
    if (!incremented && reply.text === "" && reply.toolCalls.length === 0) {
      throw new ProviderTransportError("the streamed reply carried no records");
    }
    return { reply, streamed: true };
  } catch (error) {
    if (!(error instanceof ProviderTransportError || error instanceof ProviderHttpError))
      throw error;
    const result = await client.chat({
      model: options.model,
      messages: options.messages,
      tools: [CAPABILITY_TOOL],
      toolChoice: "auto",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return {
      reply: {
        text: result.text,
        toolCalls: result.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      },
      streamed: false,
    };
  }
}

/** Run the test and derive the flags from the turn it observed. */
export async function runCapabilityTest(options: CapabilityTestOptions): Promise<CapabilityTurn> {
  const client =
    options.client ??
    new OpenAiCompatibleClient(
      { baseUrl: options.baseUrl, apiKey: options.apiKey },
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
  const messages: ChatMessage[] = [{ role: "user", content: CAPABILITY_PROMPT }];
  const deltas: Deltas = { text: 0, toolCalls: 0 };
  const step = {
    model: options.model,
    deltas,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  let requests = 0;
  let wholeReplies = 0;
  const first = await oneRequest(client, { ...step, messages });
  requests += 1;
  if (!first.streamed) wholeReplies += 1;
  const calls = first.reply.toolCalls;
  let answer = first.reply.text;
  let structured: StructuredObservation | null = null;
  const notes: string[] = [];

  if (calls.length > 0) {
    const call = calls[0];
    if (call !== undefined) {
      // The closing reply only exists after the tool's own result goes back, which is the second
      // half of the one turn the smoke drives through Pi.
      messages.push({
        role: "assistant",
        content: first.reply.text.length === 0 ? null : first.reply.text,
        toolCalls: calls,
      });
      messages.push({ role: "tool", toolCallId: call.id, content: CAPABILITY_TEXT });
      const second = await oneRequest(client, { ...step, messages });
      requests += 1;
      if (!second.streamed) wholeReplies += 1;
      if (second.reply.text.length > 0) answer = second.reply.text;
    }
  } else {
    const outcome = await runStructuredToolTurn(client, {
      model: options.model,
      task: `Call ${CAPABILITY_TOOL.name} with text "${CAPABILITY_TEXT}".`,
      tools: [CAPABILITY_TOOL],
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    requests += 1;
    structured = {
      parsableJson: outcome.reply.kind !== "invalid",
      toolCall: outcome.reply.kind === "tool_call",
    };
    if (outcome.reply.kind === "text" && answer.length === 0) answer = outcome.reply.text;
    if (outcome.failure !== null)
      notes.push(`the structured output request failed: ${outcome.failure.reason}`);
  }

  const observation: TurnObservation = {
    toolCallsCompleted: calls.length,
    toolNames: calls.map((call) => call.name),
    textDeltas: deltas.text,
    toolCallDeltas: deltas.toolCalls,
    // A request answered whole delivered exactly one message; a streamed one delivered increments.
    assistantMessages: wholeReplies,
    assistantText: answer,
    executions: calls.map((call) => ({ toolName: call.name, isError: false })),
    settled: true,
  };

  const flags = deriveFlags(observation, null, structured);
  flags.notes.push(...notes);
  // The derived notes are shared with the Pi-driven smoke. One of them describes this path's own
  // limit rather than a Pi failure, so it is restated here as what it is.
  flags.notes = flags.notes.map((note) =>
    note.startsWith("context window unknown")
      ? "context window unknown: this test reads one reply, which carries no model list"
      : note,
  );
  if (deltas.text + deltas.toolCalls === 0) {
    flags.streaming = null;
    flags.notes = flags.notes
      .filter((note) => !note.startsWith("no incremental deltas"))
      .concat("streaming unknown: the endpoint answered whole replies");
  }

  return {
    flags,
    observation,
    structured,
    answer,
    toolNames: calls.map((call) => call.name),
    offered: [CAPABILITY_TOOL.name],
    requests,
  };
}
