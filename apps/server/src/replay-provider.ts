/**
 * The replay provider: the model's turns, read out of a committed Pi transcript.
 *
 * Keyless and model-free, this answers the loop's turn calls with what a recorded turn actually
 * held: the tool calls the model asked for, and the assistant text it streamed after the results
 * arrived. It reads through the landed `packages/pi-bridge` fixture parser, so a transcript that
 * stops parsing fails here rather than in a stream.
 *
 * The recorded text is the recording's own wording for the recorded result. A run that executes the
 * calls for real therefore gets the recording's narration, not a reaction to its own output; the
 * evidence run labels the turns it takes from the transcript for that reason.
 */

import type { ProviderPort, ProviderToolCall, ProviderTurn, TurnInput } from "@freebot/core";
import { type FixtureRecord, type PiInboundFrame, readFixture } from "@freebot/pi-bridge";

/** One recorded prompt and what the model did in it. */
export interface RecordedTurn {
  readonly prompt: string;
  /** The calls the model asked for, in recorded order. */
  readonly calls: readonly ProviderToolCall[];
  /** The text deltas it streamed in this block, in order. */
  readonly text: readonly string[];
}

function textOf(frame: PiInboundFrame): string | null {
  if (frame.type !== "message_update") return null;
  const event = frame.assistantMessageEvent;
  return event.type === "text_delta" ? event.delta : null;
}

function callOf(frame: PiInboundFrame): ProviderToolCall | null {
  if (frame.type !== "tool_execution_start") return null;
  return {
    toolCallId: frame.toolCallId,
    toolName: frame.toolName,
    args: frame.args,
    // Every call in a recorded turn reached the gate extension, so it is a governed call.
    destructive: true,
  };
}

/** Read every prompt block a transcript holds, in recorded order. */
export async function readTranscript(path: string): Promise<RecordedTurn[]> {
  const records: FixtureRecord[] = await readFixture(path);
  const turns: RecordedTurn[] = [];
  let current: { prompt: string; calls: ProviderToolCall[]; text: string[] } | null = null;

  for (const record of records) {
    if (record.dir === "bridge->pi" && !("raw" in record.sent) && record.sent.type === "prompt") {
      current = { prompt: record.sent.message, calls: [], text: [] };
      turns.push(current);
      continue;
    }
    if (record.dir !== "pi->bridge" || current === null) continue;
    const call = callOf(record.frame);
    if (call !== null) current.calls.push(call);
    const text = textOf(record.frame);
    if (text !== null) current.text.push(text);
  }

  return turns;
}

/** The block that asked for one tool, or undefined. */
export function turnForTool(
  turns: readonly RecordedTurn[],
  toolName: string,
): RecordedTurn | undefined {
  return turns.find((turn) => turn.calls.some((call) => call.toolName === toolName));
}

/** The first block that asked for any of `toolNames`, in recorded order. */
export function firstTurnForTools(
  turns: readonly RecordedTurn[],
  toolNames: readonly string[],
): RecordedTurn | undefined {
  return turns.find((turn) => turn.calls.some((call) => toolNames.includes(call.toolName)));
}

/**
 * The loop's turns for one recorded block. Pi runs the call and the follow-up text as two turns in
 * one prompt, so the block becomes two: the call, then the text the result produced, with no call
 * in it, which is what ends a run.
 */
export function turnsInBlock(block: RecordedTurn): ProviderTurn[] {
  return [
    { text: [], toolCalls: block.calls },
    { text: block.text, toolCalls: [] },
  ];
}

/** A provider that answers from a fixed turn list and records what each turn was told. */
export class ReplayProvider implements ProviderPort {
  readonly #turns: ProviderTurn[];
  readonly #asked: TurnInput[] = [];

  constructor(turns: readonly ProviderTurn[]) {
    this.#turns = [...turns];
  }

  get asked(): readonly TurnInput[] {
    return this.#asked;
  }

  async next(input: TurnInput): Promise<ProviderTurn> {
    this.#asked.push(input);
    const next = this.#turns.shift();
    if (next === undefined) throw new Error("the replay has no turn left to answer with");
    return next;
  }
}
