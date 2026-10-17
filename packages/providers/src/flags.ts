/**
 * Capability flag semantics, derived from one observed Pi turn and nothing else.
 *
 * A flag is never inferred from a model name (brief order: do not guess flags from a name). Every
 * field is either observed in the turn or explicitly unknown (`null`). `observeTurn` is a pure
 * function over the bridge's own frame union, so the same derivation runs against a live Pi
 * process and against the committed replay transcript.
 */

import type { PiEventFrame } from "../../pi-bridge/src/index.ts";

/** How reliably this connection drives Pi's tool pipeline, as observed. */
export type ToolCalling = "strong" | "weak" | "none";

export interface CapabilityFlags {
  /**
   * `strong`: the turn carried a native tool call. `weak`: no native call, but a structured reply
   * the fallback converts into one. `none`: neither, so this connection cannot drive Pi.
   */
  toolCalling: ToolCalling;
  /** `true` when the turn delivered incremental deltas, `false` when it delivered whole messages. */
  streaming: boolean | null;
  /** `true` when the connection answered a structured-output request with parsable JSON. */
  structuredOutput: boolean | null;
  /** The model entry Pi reported for this connection, or null when Pi listed none. */
  contextWindow: number | null;
  notes: string[];
}

export interface TurnObservation {
  /** Native tool calls the model emitted, counted at `toolcall_end`. */
  toolCallsCompleted: number;
  /** The names of those calls, in order. */
  toolNames: string[];
  /** Incremental text deltas observed. */
  textDeltas: number;
  /** Incremental tool-call argument deltas observed. */
  toolCallDeltas: number;
  /** Assistant `message_end` frames observed, the evidence that a whole message arrived. */
  assistantMessages: number;
  /** The last non-empty assistant text in the turn. */
  assistantText: string;
  /** Tool executions the turn ran, with the gate's outcome. */
  executions: Array<{ toolName: string; isError: boolean }>;
  /** `agent_settled` arrived: Pi will not continue. */
  settled: boolean;
}

/** One structured-output observation, or null when the path was not exercised for this connection. */
export interface StructuredObservation {
  /** The connection returned parsable JSON to a `response_format: json_object` request. */
  parsableJson: boolean;
  /** That JSON carried a tool call the fallback could convert. */
  toolCall: boolean;
}

export function observeTurn(frames: readonly PiEventFrame[]): TurnObservation {
  const observation: TurnObservation = {
    toolCallsCompleted: 0,
    toolNames: [],
    textDeltas: 0,
    toolCallDeltas: 0,
    assistantMessages: 0,
    assistantText: "",
    executions: [],
    settled: false,
  };

  for (const frame of frames) {
    switch (frame.type) {
      case "message_update": {
        const event = frame.assistantMessageEvent;
        if (event.type === "text_delta") observation.textDeltas += 1;
        if (event.type === "toolcall_delta") observation.toolCallDeltas += 1;
        if (event.type === "toolcall_end") {
          observation.toolCallsCompleted += 1;
          const call = event.toolCall;
          const name = isRecord(call) ? call.name : undefined;
          if (typeof name === "string") observation.toolNames.push(name);
        }
        break;
      }
      case "message_end": {
        if (frame.message.role !== "assistant") break;
        observation.assistantMessages += 1;
        const text = messageText(frame.message.content);
        if (text.length > 0) observation.assistantText = text;
        break;
      }
      case "tool_execution_end":
        observation.executions.push({ toolName: frame.toolName, isError: frame.isError });
        break;
      case "agent_settled":
        observation.settled = true;
        break;
      default:
        break;
    }
  }

  return observation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

export function deriveFlags(
  observation: TurnObservation,
  contextWindow: number | null,
  structured: StructuredObservation | null,
): CapabilityFlags {
  const notes: string[] = [];
  const native = observation.toolCallsCompleted > 0;
  const fallbackCall = structured?.toolCall === true && !native;

  let toolCalling: ToolCalling;
  if (native) {
    toolCalling = "strong";
    notes.push(`native tool call(s): ${observation.toolNames.join(", ")}`);
  } else if (fallbackCall) {
    toolCalling = "weak";
    notes.push("no native tool call; a structured reply parsed into a tool call");
  } else {
    toolCalling = "none";
    notes.push("no tool call observed: neither a native call nor a parsable structured reply");
  }

  const deltas = observation.textDeltas + observation.toolCallDeltas;
  const streaming = deltas > 0 ? true : observation.assistantMessages > 0 ? false : null;
  if (streaming === false) notes.push("no incremental deltas: whole messages only");
  if (streaming === null) notes.push("streaming unknown: the turn carried no assistant message");

  const structuredOutput = structured === null ? null : structured.parsableJson;
  if (structuredOutput === null) notes.push("structured output unknown: path not exercised");
  if (structuredOutput === false)
    notes.push("structured output rejected: the reply was not parsable");

  if (contextWindow === null) {
    notes.push("context window unknown: Pi listed no model entry for this connection");
  }

  for (const execution of observation.executions) {
    notes.push(
      `execution ${execution.toolName}: ${execution.isError ? "errored or denied" : "ran clean"}`,
    );
  }
  if (!observation.settled) notes.push("the turn did not settle: agent_settled never arrived");

  return { toolCalling, streaming, structuredOutput, contextWindow, notes };
}

/** The literal the artifact and the smoke print, one `key: value` line per flag. */
export function formatFlags(flags: CapabilityFlags): string[] {
  return [
    `toolCalling: ${flags.toolCalling}`,
    `streaming: ${flags.streaming === null ? "unknown" : String(flags.streaming)}`,
    `structuredOutput: ${flags.structuredOutput === null ? "unknown" : String(flags.structuredOutput)}`,
    `contextWindow: ${flags.contextWindow === null ? "unknown" : String(flags.contextWindow)}`,
  ];
}
