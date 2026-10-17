/**
 * The capability probe. One Pi tool-call turn, through the same bridge the product uses, and the
 * flags observed in it.
 *
 * Live, this means spawning `pi --mode rpc` against the user's connection (the gate-bound path).
 * Keyless, it replays the recorded tool-call turn out of the committed U0.2 transcript: the probe
 * plans which recorded commands to write and which recorded frames to deliver, then runs the same
 * derivation the live path runs.
 */

import type { PiInboundFrame, PiRequest, PiResponse } from "../../pi-bridge/src/index.ts";
import {
  allowTools,
  createReplayTransport,
  type FixtureRecord,
  fixtureInboundFrames,
  PiProtocolError,
  PiSession,
  parseFixture,
  type ReplayTransport,
} from "../../pi-bridge/src/index.ts";
import { parseStructuredReply } from "./fallback.ts";
import {
  type CapabilityFlags,
  deriveFlags,
  observeTurn,
  type StructuredObservation,
  type TurnObservation,
} from "./flags.ts";

const REPLAY_REQUEST_TIMEOUT_MS = 5_000;
const REPLAY_SETTLE_TIMEOUT_MS = 5_000;

export interface ReplayPlan {
  /** The recorded model-list exchange, written first so the context window is observed. */
  modelsRequest: PiRequest;
  /** The recorded tool-call turn. */
  turnRequest: PiRequest;
  /** The provider and model the recorded turn ran on, read off its frames. */
  provider: string;
  modelId: string;
  baseUrl: string | null;
  /** The recorded tool the model called, which the replay gate allows. */
  toolName: string;
}

/** The connection a recorded turn ran on, read off the recording. */
export interface RecordedConnection {
  provider: string;
  modelId: string;
  baseUrl: string | null;
}

export interface ProbeRun {
  flags: CapabilityFlags;
  observation: TurnObservation;
  /** The model entry Pi reported for this connection, or null. */
  contextWindow: number | null;
  /** The tool the probe asked for and watched execute. */
  toolName: string;
  /** The connection the turn ran on, or null when the caller holds it (the live path). */
  recorded: RecordedConnection | null;
  requestsWritten: number;
  /** Everything the probe wrote, for the artifact. */
  sent: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Choose the recorded turn to replay: the first prompt block that ran a tool successfully, and the
 * first `get_available_models` exchange. Only those frames are handed to the replay transport, in
 * their recorded order, so later turns in the transcript are not part of the observation.
 */
export function planReplayTurn(records: readonly FixtureRecord[]): ReplayPlan {
  interface Block {
    request: { id: string; message: string };
    frames: PiInboundFrame[];
    toolRun: string | null;
  }

  const blocks: Block[] = [];
  const modelsFrames: PiInboundFrame[] = [];
  let modelsRequestId: string | null = null;
  let modelsDone = false;
  let current: Block | null = null;

  for (const record of records) {
    if (record.dir === "bridge->pi" && !("raw" in record.sent)) {
      const command = record.sent;
      if (command.type === "prompt" && command.id !== undefined) {
        current = {
          request: { id: command.id, message: command.message },
          frames: [],
          toolRun: null,
        };
        blocks.push(current);
      }
      if (
        command.type === "get_available_models" &&
        command.id !== undefined &&
        modelsRequestId === null
      ) {
        modelsRequestId = command.id;
      }
      continue;
    }
    if (record.dir !== "pi->bridge") continue;
    const frame = record.frame;
    if (modelsRequestId !== null && !modelsDone) {
      modelsFrames.push(frame);
      if (frame.type === "response" && frame.id === modelsRequestId) modelsDone = true;
    }
    if (current === null) continue;
    current.frames.push(frame);
    if (frame.type === "tool_execution_end" && !frame.isError) current.toolRun = frame.toolName;
  }

  if (modelsRequestId === null) {
    throw new PiProtocolError("transcript carries no get_available_models exchange", "plan");
  }
  const chosen = blocks.find((block) => block.toolRun !== null);
  if (chosen === undefined || chosen.toolRun === null) {
    throw new PiProtocolError("transcript carries no prompt that ran a tool", "plan");
  }

  const models = modelsFrames.find(
    (frame): frame is PiResponse => frame.type === "response" && frame.id === modelsRequestId,
  );
  const model = readModel(models?.data, chosen);
  if (model === null) {
    throw new PiProtocolError("transcript's model list carried no model entry", "plan");
  }

  return {
    modelsRequest: { id: modelsRequestId, type: "get_available_models" },
    turnRequest: { id: chosen.request.id, type: "prompt", message: chosen.request.message },
    provider: model.provider,
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    toolName: chosen.toolRun,
  };
}

interface RecordedModel {
  provider: string;
  modelId: string;
  baseUrl: string | null;
  contextWindow: number | null;
}

/** The model entry the turn's own assistant frames name, cross-checked against Pi's model list. */
function readModel(data: unknown, block: { frames: PiInboundFrame[] }): RecordedModel | null {
  const fromFrames = block.frames
    .map((frame) =>
      frame.type === "message_start" || frame.type === "message_end" ? frame.message : undefined,
    )
    .find((message) => message !== undefined && typeof message.provider === "string");
  const provider = optionalString(fromFrames?.provider);
  const modelId = optionalString(fromFrames?.model);
  if (provider === null || modelId === null) return null;

  const listed = isRecord(data) && Array.isArray(data.models) ? data.models : [];
  const entry = listed.find(
    (candidate) =>
      isRecord(candidate) && candidate.provider === provider && candidate.id === modelId,
  );
  const contextWindow = isRecord(entry) ? entry.contextWindow : undefined;
  return {
    provider,
    modelId,
    baseUrl: isRecord(entry) ? optionalString(entry.baseUrl) : null,
    contextWindow: typeof contextWindow === "number" ? contextWindow : null,
  };
}

/**
 * The structured-output observation the turn itself carries. A native tool call leaves the path
 * unexercised (`null`); a JSON-shaped text reply is the observation, good or bad.
 */
export function structuredFromTurn(observation: TurnObservation): StructuredObservation | null {
  if (observation.toolCallsCompleted > 0) return null;
  const text = observation.assistantText.trim();
  if (text.length === 0) return null;
  const reply = parseStructuredReply(text);
  return { parsableJson: reply.kind !== "invalid", toolCall: reply.kind === "tool_call" };
}

export interface SessionProbeOptions {
  contextWindow: number | null;
  structured: StructuredObservation | null;
  toolName: string;
}

/** Everything the probe observed, before the flags are derived from it. */
export interface ProbeEvidence extends SessionProbeOptions {
  observation: TurnObservation;
  recorded: RecordedConnection | null;
  /** Commands the probe wrote, trimmed. */
  sent: string[];
  requestsWritten: number;
}

/** Derive the flags for one observed turn and assemble the run record. */
export function probeRun(evidence: ProbeEvidence): ProbeRun {
  return {
    flags: deriveFlags(evidence.observation, evidence.contextWindow, evidence.structured),
    observation: evidence.observation,
    contextWindow: evidence.contextWindow,
    toolName: evidence.toolName,
    recorded: evidence.recorded,
    requestsWritten: evidence.requestsWritten,
    sent: evidence.sent,
  };
}

/**
 * Replay one recorded tool-call turn and derive its flags. Writes the recorded commands in order,
 * then drains the chosen block's frames.
 */
export async function probeReplayTurn(records: readonly FixtureRecord[]): Promise<ProbeRun> {
  const plan = planReplayTurn(records);
  const transport: ReplayTransport = createReplayTransport(replayFrames(records, plan));
  const session = new PiSession(transport, {
    gate: allowTools([plan.toolName]),
    requestTimeoutMs: REPLAY_REQUEST_TIMEOUT_MS,
  });
  const settled = session.waitForSettled(REPLAY_SETTLE_TIMEOUT_MS);
  try {
    const models = await session.request(plan.modelsRequest);
    const contextWindow = contextWindowFor(models.data, plan);
    await session.request(plan.turnRequest);
    transport.drain();
    await settled;
    const observation = observeTurn(session.events);
    return probeRun({
      observation,
      contextWindow,
      structured: structuredFromTurn(observation),
      toolName: plan.toolName,
      recorded: { provider: plan.provider, modelId: plan.modelId, baseUrl: plan.baseUrl },
      requestsWritten: 2,
      sent: transport.sent.map((line) => line.trim()),
    });
  } finally {
    session.close();
  }
}

/** The model-list frame plus the chosen turn's frames, in recorded order. */
function replayFrames(records: readonly FixtureRecord[], plan: ReplayPlan): PiInboundFrame[] {
  const frames = fixtureInboundFrames(records);
  const modelsFrame = frames.find(
    (frame) => frame.type === "response" && frame.id === plan.modelsRequest.id,
  );
  if (modelsFrame === undefined) {
    throw new PiProtocolError("transcript's model list exchange has no response frame", "plan");
  }
  const turnIndex = frames.findIndex(
    (frame) => frame.type === "response" && frame.id === plan.turnRequest.id,
  );
  if (turnIndex === -1) {
    throw new PiProtocolError("transcript's chosen turn has no response frame", "plan");
  }
  const rest = frames.slice(turnIndex);
  const settledIndex = rest.findIndex((frame) => frame.type === "agent_settled");
  if (settledIndex === -1) {
    throw new PiProtocolError("transcript's chosen turn never settled", "plan");
  }
  return [modelsFrame, ...rest.slice(0, settledIndex + 1)];
}

function contextWindowFor(data: unknown, plan: ReplayPlan): number | null {
  if (!isRecord(data) || !Array.isArray(data.models)) return null;
  const entry = data.models.find(
    (candidate) =>
      isRecord(candidate) && candidate.provider === plan.provider && candidate.id === plan.modelId,
  );
  return isRecord(entry) && typeof entry.contextWindow === "number" ? entry.contextWindow : null;
}

/** Read the committed transcript and replay its tool-call turn. */
export async function probeReplayFixture(path: string): Promise<ProbeRun> {
  return probeReplayTurn(parseFixture(await Bun.file(path).text()));
}
