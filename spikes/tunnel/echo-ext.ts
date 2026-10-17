/**
 * The tool the spike's stub model calls. `delay_ms` widens the window a tool call occupies on
 * the wire, so the harness can land a kill inside it deterministically.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const echo = defineTool({
  name: "spike_echo",
  label: "Tunnel spike echo",
  description: "Echo a note back, after an optional delay.",
  parameters: Type.Object({
    note: Type.String(),
    delay_ms: Type.Number(),
  }),
  async execute(_toolCallId, params) {
    if (params.delay_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, params.delay_ms));
    }
    return {
      content: [{ type: "text" as const, text: `echo: ${params.note}` }],
      details: { note: params.note },
    };
  },
});

export default function spikeEcho(pi: ExtensionAPI): void {
  pi.registerTool(echo);
}
