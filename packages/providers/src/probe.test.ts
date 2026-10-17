import { describe, expect, test } from "bun:test";
import { PiProtocolError, parseFixture } from "../../pi-bridge/src/index.ts";
import { deriveFlags, observeTurn, type TurnObservation } from "./flags.ts";
import { planReplayTurn, probeReplayFixture } from "./probe.ts";

const FIXTURE = new URL("../../pi-bridge/fixtures/rpc-handshake.jsonl", import.meta.url);
const records = parseFixture(await Bun.file(FIXTURE).text());

describe("the replay plan over the committed transcript", () => {
  test("it selects the recorded turn that ran a tool, and the model that turn ran on", () => {
    const plan = planReplayTurn(records);
    expect(plan.turnRequest).toEqual({
      id: "turn-echo",
      type: "prompt",
      message: "spike: call gated_echo",
    });
    expect(plan.modelsRequest).toEqual({ id: "models-1", type: "get_available_models" });
    expect(plan.toolName).toBe("gated_echo");
    expect(plan.provider).toBe("stub");
    expect(plan.modelId).toBe("stub-1");
    expect(plan.baseUrl).toBe("http://127.0.0.1:63501/v1");
  });

  test("a transcript with no turn that ran a tool is refused, not replayed into a false flag", () => {
    const bare = parseFixture(
      [
        '{"dir":"bridge->pi","id":"models-1","type":"get_available_models"}',
        '{"dir":"pi->bridge","id":"models-1","type":"response","command":"get_available_models","success":true,"data":{"models":[]}}',
        '{"dir":"bridge->pi","id":"p1","type":"prompt","message":"hello"}',
        '{"dir":"pi->bridge","id":"p1","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}',
        '{"dir":"pi->bridge","type":"agent_settled","aborted":false}',
      ].join("\n"),
    );
    expect(() => planReplayTurn(bare)).toThrow(PiProtocolError);
  });
});

describe("the probe over the recorded turn", () => {
  test("its capability table is the observed turn, one flag per fact", async () => {
    const run = await probeReplayFixture(FIXTURE.pathname);

    expect(run.flags.toolCalling).toBe("strong");
    expect(run.flags.streaming).toBe(true);
    expect(run.flags.structuredOutput).toBeNull();
    expect(run.flags.contextWindow).toBe(128000);
    expect(run.flags.notes).toEqual([
      "native tool call(s): gated_echo",
      "structured output unknown: path not exercised",
      "execution gated_echo: ran clean",
    ]);

    expect(run.observation.toolCallsCompleted).toBe(1);
    expect(run.observation.toolNames).toEqual(["gated_echo"]);
    expect(run.observation.textDeltas).toBe(1);
    expect(run.observation.toolCallDeltas).toBe(2);
    expect(run.observation.executions).toEqual([{ toolName: "gated_echo", isError: false }]);
    expect(run.observation.settled).toBe(true);
    expect(run.observation.assistantText).toBe(
      "stub-model saw tool result: gated_echo ran: hello-from-stub",
    );
    expect(run.toolName).toBe("gated_echo");
    expect(run.requestsWritten).toBe(2);
  });

  test("the probe wrote only the recorded commands", async () => {
    const run = await probeReplayFixture(FIXTURE.pathname);
    expect(run.sent).toEqual([
      '{"id":"models-1","type":"get_available_models"}',
      '{"id":"turn-echo","type":"prompt","message":"spike: call gated_echo"}',
    ]);
  });
});

describe("flag derivation", () => {
  const observation = (overrides: Partial<TurnObservation> = {}): TurnObservation => ({
    toolCallsCompleted: 0,
    toolNames: [],
    textDeltas: 0,
    toolCallDeltas: 0,
    assistantMessages: 0,
    assistantText: "",
    executions: [],
    settled: false,
    ...overrides,
  });

  test("a native call is strong, whatever the gate then did with it", () => {
    const flags = deriveFlags(
      observation({
        toolCallsCompleted: 1,
        toolNames: ["gated_blocked"],
        executions: [{ toolName: "gated_blocked", isError: true }],
        toolCallDeltas: 2,
        settled: true,
      }),
      128000,
      null,
    );
    expect(flags.toolCalling).toBe("strong");
    expect(flags.streaming).toBe(true);
    expect(flags.notes).toContain("execution gated_blocked: errored or denied");
  });

  test("no native call but a parsable structured reply is weak", () => {
    const flags = deriveFlags(
      observation({ assistantMessages: 1, assistantText: '{"tool":"echo"}', settled: true }),
      null,
      { parsableJson: true, toolCall: true },
    );
    expect(flags.toolCalling).toBe("weak");
    expect(flags.streaming).toBe(false);
    expect(flags.structuredOutput).toBe(true);
    expect(flags.contextWindow).toBeNull();
    expect(flags.notes).toContain("no incremental deltas: whole messages only");
    expect(flags.notes).toContain(
      "context window unknown: Pi listed no model entry for this connection",
    );
  });

  test("nothing observed is none with the unknowns named", () => {
    const flags = deriveFlags(observation(), null, { parsableJson: false, toolCall: false });
    expect(flags.toolCalling).toBe("none");
    expect(flags.streaming).toBeNull();
    expect(flags.structuredOutput).toBe(false);
    expect(flags.notes).toContain("the turn did not settle: agent_settled never arrived");
  });

  test("an unevaluated structured path stays unknown rather than false", () => {
    const flags = deriveFlags(observation({ assistantMessages: 1 }), null, null);
    expect(flags.structuredOutput).toBeNull();
    expect(flags.notes).toContain("structured output unknown: path not exercised");
  });
});

describe("turn observation", () => {
  test("it reads the frames the bridge already defines", () => {
    const frames = records
      .filter((record) => record.dir === "pi->bridge")
      .map((record) => record.frame)
      .filter((frame) => frame.type !== "response")
      .slice(0, 60);
    const observed = observeTurn(frames);
    expect(observed.settled).toBe(true);
    expect(observed.executions.map((execution) => execution.toolName)).toEqual([
      "gated_blocked",
      "gated_echo",
    ]);
  });
});
