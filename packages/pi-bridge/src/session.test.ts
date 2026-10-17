import { describe, expect, test } from "bun:test";
import { PiCommandError, PiTransportError } from "./errors.ts";
import type { BashExecutionUpdateFrame, ToolExecutionEndEvent } from "./frames.ts";
import { fixtureInboundFrames, parseFixture } from "./frames.ts";
import { PiSession } from "./session.ts";
import { createReplayTransport } from "./transport.ts";

const fixture = new URL("../fixtures/rpc-handshake.jsonl", import.meta.url);
const frames = fixtureInboundFrames(parseFixture(await Bun.file(fixture).text()));

function newSession() {
  const transport = createReplayTransport(frames);
  const session = new PiSession(transport, { requestTimeoutMs: 2000 });
  return { transport, session };
}

/** The message_update label, e.g. `message_update:toolcall_start`, for ordered-event assertions. */
const label = (kind: string, update?: string): string =>
  update === undefined ? kind : `${kind}:${update}`;

describe("PiSession over the recorded transcript", () => {
  test("a response correlates by id, and the session writes the command it was given", async () => {
    const { transport, session } = newSession();
    const response = await session.request({ id: "state-1", type: "get_state" });
    expect(response.success).toBe(true);
    const data = response.data as { model: { id: string }; isStreaming: boolean };
    expect(data.model.id).toBe("stub-1");
    expect(data.isStreaming).toBe(false);
    expect(transport.sent).toEqual(['{"id":"state-1","type":"get_state"}\n']);
  });

  test("a success:false response rejects with a typed error carrying the wire's text", async () => {
    const { session } = newSession();
    await session.request({ id: "state-1", type: "get_state" });
    let caught: unknown;
    try {
      await session.request({
        id: "badmodel-1",
        type: "set_model",
        provider: "not-a-provider",
        modelId: "nope",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PiCommandError);
    const error = caught as PiCommandError;
    expect(error.message).toBe("set_model failed: Model not found: not-a-provider/nope");
    expect(error.command).toBe("set_model");
    expect(error.id).toBe("badmodel-1");
  });

  test("an id-less parse response surfaces as a typed protocol error", async () => {
    const { session } = newSession();
    await session.request({ id: "state-1", type: "get_state" });
    await session.request({ id: "commands-1", type: "get_commands" });
    expect(session.protocolErrors.length).toBe(1);
    expect(session.protocolErrors[0]?.message).toBe("response without a pending request: parse");
  });

  test("a command with no recorded response fails the replay loudly", async () => {
    const { session } = newSession();
    let caught: unknown;
    try {
      await session.request({ id: "absent-1", type: "get_state" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PiTransportError);
    expect((caught as PiTransportError).message).toBe(
      "replay: no recorded response for id absent-1",
    );
  });

  test("a full recorded session: ordered events, settle boundary, and totals", async () => {
    const { transport, session } = newSession();
    const settled = session.waitForSettled(2000);

    await session.request({ id: "state-1", type: "get_state" });
    const commands = await session.request({ id: "commands-1", type: "get_commands" });
    const commandNames = (commands.data as { commands: Array<{ name: string }> }).commands.map(
      (entry) => entry.name,
    );
    expect(commandNames).toContain("gate-info");

    const bash = await session.request({
      id: "bash-1",
      type: "bash",
      command: "echo native-bash-no-model",
    });
    const bashData = bash.data as { output: string; exitCode: number };
    expect(bashData.output).toBe("native-bash-no-model\n");
    expect(bashData.exitCode).toBe(0);
    const update = session.events.find(
      (event): event is BashExecutionUpdateFrame => event.type === "bash_execution_update",
    );
    expect(update?.delta).toBe("native-bash-no-model\n");
    expect(update?.id).toBe("bash-1");

    const info = await session.request({ id: "cmd-info-1", type: "prompt", message: "/gate-info" });
    expect((info.data as { disposition: string }).disposition).toBe("handled");

    const mark = session.events.length;
    await session.request({
      id: "turn-blocked",
      type: "prompt",
      message: "spike: call gated_blocked",
    });
    await session.request({ id: "turn-echo", type: "prompt", message: "spike: call gated_echo" });
    expect(
      session.events
        .slice(mark)
        .map((event) =>
          label(
            event.type,
            event.type === "message_update" ? event.assistantMessageEvent.type : undefined,
          ),
        ),
    ).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "message_start",
      "message_update:toolcall_start",
      "message_update:toolcall_delta",
      "message_update:toolcall_delta",
      "message_update:toolcall_end",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_update:text_start",
      "message_update:text_delta",
      "message_update:text_end",
      "message_end",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);

    await session.request({
      id: "turn-confirm-deny",
      type: "prompt",
      message: "spike: call gated_confirm_deny",
    });
    await session.request({
      id: "turn-confirm-allow",
      type: "prompt",
      message: "spike: call gated_confirm_allow",
    });
    const runnerMark = session.events.length;
    await session.request({
      id: "turn-runner",
      type: "prompt",
      message: "spike: call gate_demo_runner",
    });
    await session.request({
      id: "turn-native-bash",
      type: "prompt",
      message: "spike: use native bash",
    });
    const nested = session.events
      .slice(runnerMark)
      .filter(
        (event): event is ToolExecutionEndEvent =>
          event.type === "tool_execution_end" && event.toolName === "gated_echo",
      );
    expect(nested.length).toBe(1);
    expect(nested[0]?.toolCallId).toBe("call_stub_9/1");
    expect(nested[0]?.parentToolCallId).toBe("call_stub_9");

    transport.drain();
    await settled;

    expect(session.events.length).toBe(152);
    expect(session.events.at(-1)?.type).toBe("agent_settled");

    // The two recorded approval dialogs are not freebot tool gates; the session cancels them
    // rather than leaving Pi parked.
    const cancels = transport.sent.filter((line) => line.includes("cancelled"));
    expect(cancels).toEqual([
      '{"type":"extension_ui_response","id":"e99a83d5-e0f3-4e02-aeb4-acaefaa7edb0","cancelled":true}\n',
      '{"type":"extension_ui_response","id":"2311f31f-c471-4dd1-b770-80a084755d6b","cancelled":true}\n',
    ]);
    expect(session.toolGates).toEqual([]);
  });
});
