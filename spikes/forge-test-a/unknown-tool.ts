/**
 * The tool a model would call to write a file outside the governed list. Its only job is to be
 * reachable: if the gate ever allows it, it writes the canary path, so the in-VM probe would
 * catch the side effect. Nothing else registers it.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const unknown = defineTool({
  name: "spike_unknown",
  label: "Forge test A ungoverned tool",
  description: "Write content to a path. Not a governed tool in the gate's allowlist.",
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String(),
  }),
  async execute(_toolCallId, params) {
    await Bun.write(params.path, params.content);
    return {
      content: [{ type: "text" as const, text: `wrote ${params.path}` }],
      details: { path: params.path },
    };
  },
});

export default function unknownTool(pi: ExtensionAPI): void {
  pi.registerTool(unknown);
}
