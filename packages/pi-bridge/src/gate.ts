/**
 * The Gate 1 seam: one decision function consulted for every tool call, and the wire codec that
 * carries the decision across the RPC extension UI sub-protocol.
 *
 * The intercept itself lives inside Pi as an extension `tool_call` handler
 * (`extension/tool-gate.ts`), which asks the bridge over an `input` dialog: the request's
 * `placeholder` carries the tool call as JSON, the response's `value` carries the decision as
 * JSON. The dialog always carries a timeout, and every failure to answer is a denial.
 */

/** One tool call as the gate sees it. Nested calls carry their parent's id. */
export interface ToolCallContext {
  toolCallId: string;
  toolName: string;
  args: unknown;
  parentToolCallId?: string;
}

/** A decision. Allowing has no payload; denying always names a reason. */
export type ToolGateDecision = { allow: true } | { allow: false; reason: string };

export type ToolGate = (call: ToolCallContext) => ToolGateDecision | Promise<ToolGateDecision>;

/** The dialog title that marks a freebot tool-gate request on the extension UI channel. */
export const TOOL_GATE_TITLE = "freebot.tool_gate";

/** How long the shipped extension waits for the bridge before Pi auto-resolves the dialog. */
export const GATE_DIALOG_TIMEOUT_MS = 120_000;

/** Denies everything: the default for an unknown or unconfigured gate. */
export const defaultDenyGate: ToolGate = (call) => ({
  allow: false,
  reason: `default deny: no rule for tool ${call.toolName}`,
});

/** Allows exactly the named tools; everything else gets the default denial. */
export function allowTools(names: readonly string[]): ToolGate {
  const allowed = new Set(names);
  return (call) =>
    allowed.has(call.toolName)
      ? { allow: true }
      : { allow: false, reason: `default deny: no rule for tool ${call.toolName}` };
}

/** Run the gate. A handler that throws yields a denial naming the failure; never throws. */
export async function decideToolCall(
  gate: ToolGate,
  call: ToolCallContext,
): Promise<ToolGateDecision> {
  try {
    return await gate(call);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { allow: false, reason: `gate handler threw: ${message}` };
  }
}

/** What the extension decodes when the bridge never answered (cancel, timeout, dead bridge). */
export const NO_GATE_DECISION = "no gate decision: dialog cancelled or timed out";

/** Encode a tool call for the dialog request's `placeholder` field. */
export function encodeToolGateRequest(call: ToolCallContext): string {
  return JSON.stringify(call);
}

/** Decode the dialog request payload. Malformed input denies by coming back undefined. */
export function decodeToolGateRequest(payload: string | undefined): ToolCallContext | undefined {
  if (payload === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") {
    return undefined;
  }
  if (typeof record.parentToolCallId === "string") {
    return {
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      args: record.args,
      parentToolCallId: record.parentToolCallId,
    };
  }
  return { toolCallId: record.toolCallId, toolName: record.toolName, args: record.args };
}

/** Encode a decision for the dialog response's `value` field. */
export function encodeToolGateDecision(decision: ToolGateDecision): string {
  return JSON.stringify(decision);
}

/** Decode the dialog response. Anything but an explicit allow is a denial. */
export function decodeToolGateDecision(value: string | undefined): ToolGateDecision {
  if (value === undefined) return { allow: false, reason: NO_GATE_DECISION };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { allow: false, reason: `malformed gate decision: ${value.slice(0, 200)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { allow: false, reason: `malformed gate decision: ${value.slice(0, 200)}` };
  }
  const record = parsed as Record<string, unknown>;
  if (record.allow !== true) {
    return {
      allow: false,
      reason: typeof record.reason === "string" ? record.reason : "denied without a reason",
    };
  }
  return { allow: true };
}
