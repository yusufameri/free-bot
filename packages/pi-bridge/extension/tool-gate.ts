/**
 * Gate 1 intercept: one `tool_call` handler for every tool invocation that reaches Pi's tool
 * pipeline, including nested `ctx.executeTool()` calls. It forwards the call to the bridge over
 * an `input` dialog and blocks unless the bridge answers with an allow.
 *
 * Loaded by the bridge's smoke script with `pi --mode rpc -e extension/tool-gate.ts`. The dialog
 * always carries a timeout, so a dead or silent bridge denies instead of parking Pi forever.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decodeToolGateDecision,
  encodeToolGateRequest,
  GATE_DIALOG_TIMEOUT_MS,
  TOOL_GATE_TITLE,
  type ToolCallContext,
} from "../src/gate.ts";

export default function toolGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const call: ToolCallContext = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.input,
      ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
    };
    const answer = await ctx.ui.input(TOOL_GATE_TITLE, encodeToolGateRequest(call), {
      timeout: GATE_DIALOG_TIMEOUT_MS,
    });
    const decision = decodeToolGateDecision(answer);
    if (decision.allow) return undefined;
    return { block: true, reason: `denied by freebot gate: ${decision.reason}` };
  });
}
