/**
 * Replay extension for the pinned sandbox image: one echo tool, no imports.
 *
 * Adapted from `spikes/pi-rpc/gate-ext.ts` (this unit's own copy; the gate is not exercised here).
 * The tool is declared with a raw JSON schema instead of the `typebox` helper so the file resolves
 * with no `node_modules` next to it inside the image. Pi loads extensions with jiti, so plain
 * JavaScript syntax in a `.ts` file is fine.
 */
const text = (value) => ({ type: "text", text: value });

export default function replayExtension(pi) {
  pi.registerTool({
    name: "replay_echo",
    label: "Replay echo",
    description:
      "Echo text back. Proves a replay tool call executes and its result reaches the model.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
    async execute(_toolCallId, params) {
      return {
        content: [text(`replay_echo ran: ${params.text}`)],
        details: { text: params.text },
      };
    },
  });
}
