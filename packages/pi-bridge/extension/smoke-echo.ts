/**
 * The tool the smoke script asks a live model to call. Registered under its own extension so the
 * gate extension stays a pure intercept.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SMOKE_ECHO_TOOL } from "./smoke-tool.ts";

const echo = defineTool({
  name: SMOKE_ECHO_TOOL,
  label: "FreeBot smoke echo",
  description: "Echo text back. Used by the pi-bridge smoke script to prove one gated tool call.",
  parameters: Type.Object({ text: Type.String() }),
  execute(_toolCallId, params) {
    return Promise.resolve({
      content: [{ type: "text" as const, text: `echo: ${params.text}` }],
      details: { text: params.text },
    });
  },
});

export default function smokeEcho(pi: ExtensionAPI): void {
  pi.registerTool(echo);
}
