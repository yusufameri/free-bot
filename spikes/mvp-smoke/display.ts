// Display stream for the MVP smoke dry run (U0.11): the composer's mapping from the live pi
// frame log (sparse, pi-minted seqs) onto the U0.10 page's dense display envelope, plus the
// durable display log the page resumes from.
//
// The mapping is the U0.10 `map.ts` contract applied live instead of over a fixture: turn
// counting, text deltas, tool cards, results, and a terminal stream_end. Approval frames are
// NOT derived from pi frames: the composer emits them when the gate dialog is handled, because
// only the control plane knows whether the call is approvable.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SeqLog } from "@freebot/core";
import type { PiInboundFrame } from "@freebot/pi-bridge";
import type { DisplayFrame } from "./envelope.ts";

export function commandOf(toolName: string, args: unknown): string {
  return `${toolName} ${JSON.stringify(args ?? {})}`;
}

/**
 * The spike-local risk classifier: a bash command that names `rm` needs a human. The real
 * classifier is the Phase 5 policy engine; this run only needs one destructive step to gate.
 */
export function isDestructive(toolName: string, args: unknown): boolean {
  if (toolName !== "bash") return false;
  const command = (args as { command?: unknown } | undefined)?.command;
  return typeof command === "string" && /\brm\b/.test(command);
}

export function resultOutput(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  return (content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** Facts the live mapper carries across frames; rebuilt from the logs after a restart. */
export interface MapperState {
  turn: number;
  commands: Map<string, string>;
  denied: Set<string>;
}

export function initialMapperState(): MapperState {
  return { turn: 0, commands: new Map(), denied: new Set() };
}

/**
 * Map one pi frame to one display frame (without a seq), mutating mapper state. `null` means
 * the frame type is outside the display contract (U0.10's dropped set).
 */
export function mapPiFrame(
  frame: PiInboundFrame,
  state: MapperState,
): Omit<DisplayFrame, "seq"> | null {
  switch (frame.type) {
    case "turn_start":
      state.turn += 1;
      return { type: "turn_start", payload: { turn: state.turn } };
    case "message_update": {
      const event = frame.assistantMessageEvent as { type?: string; delta?: string };
      if (event.type === "text_delta" && typeof event.delta === "string") {
        return { type: "message_delta", payload: { text: event.delta } };
      }
      return null;
    }
    case "tool_execution_start": {
      const args = (frame.args ?? {}) as Record<string, unknown>;
      const command = commandOf(frame.toolName, args);
      state.commands.set(frame.toolCallId, command);
      return {
        type: "tool_call",
        payload: {
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          command,
          destructive: isDestructive(frame.toolName, args),
        },
      };
    }
    case "tool_execution_end": {
      const denied = state.denied.has(frame.toolCallId);
      return {
        type: "tool_result",
        payload: {
          toolCallId: frame.toolCallId,
          ok: frame.isError !== true,
          denied,
          output: denied ? "" : resultOutput(frame.result),
          durationMs: typeof frame.durationMs === "number" ? frame.durationMs : null,
        },
      };
    }
    case "turn_end":
      return { type: "turn_end", payload: { turn: state.turn } };
    default:
      return null;
  }
}

/**
 * The durable display log: dense seqs minted on the host, appended to display.jsonl so the page
 * resumes from exactly what it last saw, and reloaded verbatim after a restart.
 */
export class DisplayLog {
  readonly #log = new SeqLog<Omit<DisplayFrame, "seq">>();
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const entry = JSON.parse(line) as { seq: number } & Omit<DisplayFrame, "seq">;
      const { seq, ...frame } = entry;
      const outcome = this.#log.append(seq, frame as Omit<DisplayFrame, "seq">);
      if (outcome !== "appended")
        throw new Error(`display log does not reload cleanly: ${outcome}`);
    }
  }

  get lastSeq(): number {
    return this.#log.lastSeq;
  }

  get count(): number {
    return this.#log.count;
  }

  emit(frameWithoutSeq: Omit<DisplayFrame, "seq">): DisplayFrame {
    const seq = this.#log.lastSeq + 1;
    const frame = { seq, ...frameWithoutSeq } as DisplayFrame;
    const outcome = this.#log.append(seq, frame as Omit<DisplayFrame, "seq">);
    if (outcome !== "appended") throw new Error(`display seq refused: ${outcome}`);
    appendFileSync(this.#path, `${JSON.stringify(frame)}\n`);
    return frame;
  }

  since(lastSeenSeq: number): DisplayFrame[] {
    return this.#log
      .since(lastSeenSeq)
      .map((entry) => ({ seq: entry.seq, ...entry.frame }) as DisplayFrame);
  }

  audit(): ReturnType<SeqLog<Omit<DisplayFrame, "seq">>["audit"]> {
    return this.#log.audit();
  }
}
