/**
 * Wire types for `pi --mode rpc` (pinned package 1.3.0) plus strict JSONL parse and serialize
 * helpers. Shapes follow the pinned package's docs (rpc.md, rpc-commands.md, json.md,
 * rpc-extension-ui.md); every frame kind here appears in `fixtures/rpc-handshake.jsonl`, the
 * committed U0.2 transcript.
 */

import { PiProtocolError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Commands (bridge -> pi)
// ---------------------------------------------------------------------------

/** A response to an `extension_ui_request`. `id` repeats the request's id. */
export interface PiExtensionUiResponse {
  type: "extension_ui_response";
  id: string;
  confirmed?: boolean;
  value?: string;
  cancelled?: boolean;
}

/** A stdin command. `id` is optional on the wire; `PiSession.request` always sets one. */
export type PiCommand =
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "bash"; command: string }
  | { id?: string; type: "prompt"; message: string }
  | PiExtensionUiResponse;

/** A command that Pi answers with a `response` frame. */
export type PiRequest = Exclude<PiCommand, PiExtensionUiResponse>;

// ---------------------------------------------------------------------------
// Responses (pi -> bridge)
// ---------------------------------------------------------------------------

/** Pi's answer to one command. `command: "parse"` with no id reports malformed stdin JSON. */
export interface PiResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Session events (pi -> bridge)
// ---------------------------------------------------------------------------

export interface AgentMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  stopReason?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/** The deleted-cumulative form of Pi's assistant message events (json.md). */
export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: unknown }
  | { type: "done"; reason: string; message: unknown }
  | { type: "error"; reason: string; error: string };

export interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export interface MessageStartEvent {
  type: "message_start";
  message: AgentMessage;
}

export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

export interface MessageUpdateEvent {
  type: "message_update";
  usage?: unknown;
  assistantMessageEvent: AssistantMessageEvent;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  parentToolCallId?: string;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult?: ToolResult;
  parentToolCallId?: string;
}

/** `durationMs` is present only when the tool's `execute()` actually ran. */
export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  isError: boolean;
  durationMs?: number;
  parentToolCallId?: string;
}

export interface TurnEndEvent {
  type: "turn_end";
  message: AgentMessage;
  toolResults: unknown[];
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
  willRetry?: boolean;
}

/** Pi will not continue automatically. The run boundary, unlike `agent_end`. */
export interface AgentSettledEvent {
  type: "agent_settled";
  aborted?: boolean;
}

/** The stdout frame of a direct RPC `bash` command; repeats the command id when given. */
export interface BashExecutionUpdateFrame {
  type: "bash_execution_update";
  id?: string;
  delta: string;
}

export type PiSessionEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | MessageStartEvent
  | MessageEndEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | TurnEndEvent
  | AgentEndEvent
  | AgentSettledEvent;

/** A frame kind this client does not model, wrapped so the union stays narrowable. */
export interface PiUnknownFrame {
  type: "unknown_frame";
  raw: { type: string } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Extension UI sub-protocol (pi -> bridge, answered by extension_ui_response)
// ---------------------------------------------------------------------------

export interface ExtensionUiRequestFrame {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Present on dialog methods that auto-resolve; the bridge requires it for tool gates. */
  timeout?: number;
  notifyType?: string;
  [key: string]: unknown;
}

export type PiInboundFrame =
  | PiResponse
  | PiSessionEvent
  | BashExecutionUpdateFrame
  | ExtensionUiRequestFrame
  | PiUnknownFrame;

/** Every inbound frame that is not a command response. */
export type PiEventFrame = Exclude<PiInboundFrame, PiResponse>;

// ---------------------------------------------------------------------------
// Parse and serialize
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one stdout line. Splits on LF only; an optional preceding CR is stripped (rpc.md). */
export function parseFrame(line: string): PiInboundFrame {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PiProtocolError(`stdout line is not JSON: ${String(error)}`, text);
  }
  return asInboundFrame(value);
}

/** Validate the discriminant of an inbound frame and return it typed. */
export function asInboundFrame(value: unknown): PiInboundFrame {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new PiProtocolError("frame is not an object with a string type", JSON.stringify(value));
  }
  if (value.type === "response") {
    if (typeof value.command !== "string" || typeof value.success !== "boolean") {
      throw new PiProtocolError("response frame lacks command/success", JSON.stringify(value));
    }
    return value as unknown as PiResponse;
  }
  if (value.type === "extension_ui_request") {
    if (typeof value.id !== "string" || typeof value.method !== "string") {
      throw new PiProtocolError(
        "extension_ui_request lacks a string id/method",
        JSON.stringify(value),
      );
    }
    return value as unknown as ExtensionUiRequestFrame;
  }
  switch (value.type) {
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "agent_end":
    case "agent_settled":
    case "message_start":
    case "message_end":
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "bash_execution_update":
      return value as unknown as PiInboundFrame;
    default:
      return { type: "unknown_frame", raw: value as { type: string } & Record<string, unknown> };
  }
}

/** Serialize one stdin command as a JSONL record. */
export function serializeFrame(frame: PiCommand): string {
  return `${JSON.stringify(frame)}\n`;
}

// ---------------------------------------------------------------------------
// Fixture envelope (packages/pi-bridge/fixtures/rpc-handshake.jsonl)
// ---------------------------------------------------------------------------

/** A bridge->pi fixture line that is not a command: the malformed-JSON probe. */
export interface FixtureRawLine {
  raw: string;
}

export type FixtureRecord =
  | { dir: "header" | "note" | "stub" | "pi-stderr"; record: Record<string, unknown> }
  | { dir: "check"; ok: boolean; label: string }
  | { dir: "bridge->pi"; sent: PiCommand | FixtureRawLine }
  | { dir: "pi->bridge"; frame: PiInboundFrame };

function parseFixtureJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new PiProtocolError(`fixture line is not JSON: ${String(error)}`, line);
  }
}

/** Parse one committed transcript line into its envelope record. */
export function parseFixtureLine(line: string): FixtureRecord {
  const value = parseFixtureJson(line);
  if (!isRecord(value) || typeof value.dir !== "string") {
    throw new PiProtocolError("fixture line has no dir", line);
  }
  const { dir, ...rest } = value;
  switch (dir) {
    case "header":
    case "note":
    case "stub":
    case "pi-stderr":
      return { dir, record: rest };
    case "check":
      if (typeof rest.ok !== "boolean" || typeof rest.label !== "string") {
        throw new PiProtocolError("check line lacks ok/label", line);
      }
      return { dir: "check", ok: rest.ok, label: rest.label };
    case "bridge->pi":
      if (typeof rest.type !== "string") {
        if (typeof rest.raw !== "string") {
          throw new PiProtocolError("bridge->pi line has neither type nor raw", line);
        }
        return { dir: "bridge->pi", sent: { raw: rest.raw } };
      }
      return { dir: "bridge->pi", sent: rest as unknown as PiCommand };
    case "pi->bridge":
      return { dir: "pi->bridge", frame: asInboundFrame(rest) };
    default:
      throw new PiProtocolError(`unknown fixture dir ${dir}`, line);
  }
}

/** Parse a whole transcript body. Every line must parse; a failure throws. */
export function parseFixture(text: string): FixtureRecord[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseFixtureLine(line));
}

/** The pi->bridge frames of a parsed transcript, in recorded order. */
export function fixtureInboundFrames(records: readonly FixtureRecord[]): PiInboundFrame[] {
  return records.flatMap((record) => (record.dir === "pi->bridge" ? [record.frame] : []));
}

/** Read and parse a transcript file. */
export async function readFixture(path: string): Promise<FixtureRecord[]> {
  return parseFixture(await Bun.file(path).text());
}
