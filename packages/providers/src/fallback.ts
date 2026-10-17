/**
 * The structured-output fallback for weak tool callers.
 *
 * When a connection cannot emit native tool calls, FreeBot still needs one action out of the
 * model. This module owns that path end to end: the exact instruction, the parser for the reply
 * shapes weak models actually produce, and the named failure mode when even the JSON reply does
 * not parse. The caller is the control plane; `flags.structuredOutput` records whether this path
 * worked for a connection.
 */

import {
  type ChatMessage,
  firstJsonObject,
  type OpenAiCompatibleClient,
  parseToolCallArguments,
  type ToolSpec,
} from "./client.ts";
import { ProviderRefusalError } from "./errors.ts";

/** The instruction the fallback sends. One JSON object, nothing else, and a null tool for prose. */
export const STRUCTURED_TOOL_INSTRUCTION =
  "Reply with exactly one JSON object and nothing else. " +
  'To call a tool, use {"tool": "<name>", "arguments": {<arguments>}}. ' +
  'If no tool is needed, use {"tool": null, "text": "<your answer>"}.';

export type StructuredReply =
  | {
      kind: "tool_call";
      name: string;
      arguments: string;
      args: unknown;
      repairs: string[];
    }
  | { kind: "text"; text: string; repairs: string[] }
  | { kind: "invalid"; reason: string; raw: string };

/** One fallback turn: the parsed reply, or the recorded failure mode when nothing parsed. */
export interface StructuredTurnOutcome {
  reply: StructuredReply;
  failure: { reason: string; raw: string } | null;
}

/** The messages the fallback sends: the instruction, the tool specs, then the task. */
export function structuredToolMessages(tools: readonly ToolSpec[], task: string): ChatMessage[] {
  const specs = JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    null,
    2,
  );
  return [
    { role: "system", content: STRUCTURED_TOOL_INSTRUCTION },
    { role: "user", content: `Tools:\n${specs}\n\nTask: ${task}` },
  ];
}

/**
 * Read one structured reply. Accepts a bare object, a fenced object, an object with prose around
 * it, and the `{name, arguments}` spelling; anything else is `invalid` with the reason and the
 * raw reply, so the failure is recorded rather than swallowed.
 */
export function parseStructuredReply(raw: string): StructuredReply {
  const balanced = firstJsonObject(raw);
  if (balanced === undefined) {
    return {
      kind: "invalid",
      reason: raw.includes("{")
        ? "the reply's JSON object is incomplete"
        : "no JSON object in the reply",
      raw,
    };
  }
  const repairs: string[] = [];
  if (balanced.trimmed) repairs.push("surrounding text dropped, first JSON object kept");

  let parsed: unknown;
  try {
    parsed = JSON.parse(balanced.slice);
  } catch (error) {
    return {
      kind: "invalid",
      reason: `the JSON object did not parse: ${error instanceof Error ? error.message : String(error)}`,
      raw,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "the reply was not a JSON object", raw };
  }
  const record = parsed as Record<string, unknown>;

  if ("tool" in record) {
    const tool = record.tool;
    if (tool === null) {
      const text = record.text;
      return { kind: "text", text: typeof text === "string" ? text : "", repairs };
    }
    if (typeof tool === "string" && tool.length > 0) {
      return toolCall(tool, record.arguments, repairs, raw);
    }
    return { kind: "invalid", reason: "the tool key was neither a name nor null", raw };
  }

  if (typeof record.name === "string" && record.name.length > 0) {
    repairs.push("read {name, arguments} instead of {tool, arguments}");
    return toolCall(record.name, record.arguments, repairs, raw);
  }

  return { kind: "invalid", reason: "the JSON object carried no tool key", raw };
}

function toolCall(
  name: string,
  rawArguments: unknown,
  repairs: string[],
  raw: string,
): StructuredReply {
  const text =
    typeof rawArguments === "string"
      ? rawArguments
      : rawArguments === undefined || rawArguments === null
        ? ""
        : JSON.stringify(rawArguments);
  let parsed: { args: unknown; repairs: string[] };
  try {
    parsed = parseToolCallArguments(text, name);
  } catch (error) {
    return {
      kind: "invalid",
      reason: `the tool arguments did not parse: ${error instanceof Error ? error.message : String(error)}`,
      raw,
    };
  }
  return {
    kind: "tool_call",
    name,
    arguments: text,
    args: parsed.args,
    repairs: [...repairs, ...parsed.repairs],
  };
}

/**
 * One fallback turn against the provider. The client's own failures (refusal, HTTP, timeout) come
 * back as the response's failure mode rather than as a throw, so the caller records what happened.
 */
export async function runStructuredToolTurn(
  client: OpenAiCompatibleClient,
  options: {
    model: string;
    task: string;
    tools: readonly ToolSpec[];
    timeoutMs?: number;
  },
): Promise<StructuredTurnOutcome> {
  let text: string;
  try {
    const result = await client.chat({
      model: options.model,
      messages: structuredToolMessages(options.tools, options.task),
      responseFormat: "json_object",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    text = result.text;
  } catch (error) {
    if (error instanceof ProviderRefusalError) {
      return {
        reply: {
          kind: "invalid",
          reason: "the model refused the structured-output request",
          raw: error.raw,
        },
        failure: { reason: "the model refused the structured-output request", raw: error.raw },
      };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      reply: { kind: "invalid", reason, raw: "" },
      failure: { reason, raw: "" },
    };
  }

  const reply = parseStructuredReply(text);
  if (reply.kind === "invalid") {
    return { reply, failure: { reason: reply.reason, raw: reply.raw } };
  }
  return { reply, failure: null };
}
