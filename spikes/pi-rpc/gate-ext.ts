/**
 * Gate 1 spike extension.
 *
 * One `tool_call` handler observes every tool invocation that reaches Pi's tool pipeline:
 * model-issued calls, nested `ctx.executeTool()` calls, and calls to tools other extensions
 * registered. It can mutate input or block execution; a thrown handler error also blocks the
 * call (fail-safe).
 *
 * Loaded by `drive.ts` via `pi --mode rpc --no-builtin-tools -e gate-ext.ts`.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const text = (value: string) => ({ type: "text" as const, text: value });

const gatedEcho = defineTool({
  name: "gated_echo",
  label: "Gated echo",
  description: "Echo text back. Proves a call passes the single tool_call intercept and executes.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(_toolCallId, params) {
    return {
      content: [text(`gated_echo ran: ${params.text}`)],
      details: { text: params.text },
    };
  },
});

const gatedBlocked = defineTool({
  name: "gated_blocked",
  label: "Gated blocked",
  description: "Always blocked by the gate. Its execute() must never run.",
  parameters: Type.Object({}),
  async execute() {
    return { content: [text("gated_blocked executed; the gate failed")], details: {} };
  },
});

const gatedConfirm = defineTool({
  name: "gated_confirm",
  label: "Gated confirm",
  description: "Asks the RPC client for approval through ctx.ui.confirm before running.",
  parameters: Type.Object({ mode: Type.String() }),
  async execute(_toolCallId, params) {
    return {
      content: [text(`gated_confirm executed (mode=${params.mode})`)],
      details: { mode: params.mode },
    };
  },
});

const runner = defineTool({
  name: "gate_demo_runner",
  label: "Gate demo runner",
  description: "Runs gated_echo through ctx.executeTool to prove nested calls hit the same gate.",
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    const outcome = await ctx.executeTool("gated_echo", { text: "nested-via-runner" });
    const nested = outcome.result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    return {
      content: [text(`gate_demo_runner: nested result = ${nested}`)],
      details: { nestedIsError: outcome.isError },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(gatedEcho);
  pi.registerTool(gatedBlocked);
  pi.registerTool(gatedConfirm);
  pi.registerTool(runner);

  pi.registerCommand("gate-info", {
    description: "Report the registered and active tool set through an RPC notify",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        JSON.stringify({
          mode: ctx.mode,
          hasUI: ctx.hasUI,
          allTools: pi.getAllTools().map((tool) => tool.name),
          activeTools: pi.getActiveTools(),
        }),
        "info",
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "gated_blocked") {
      return { block: true, reason: "blocked by gate-spike: always deny" };
    }
    if (event.toolName === "gated_confirm") {
      const mode = String((event.input as { mode?: unknown }).mode ?? "deny");
      const confirmed = await ctx.ui.confirm(
        "gate-spike approval",
        `Allow gated_confirm (mode=${mode})?`,
      );
      if (!confirmed) {
        return { block: true, reason: "denied by operator" };
      }
    }
    return undefined;
  });
}
