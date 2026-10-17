// Transcript -> display envelope mapping for the web-stream spike.
//
// Every generator call builds fresh frame objects, so a WebSocket connection may safely
// mutate a yielded approval_resolved payload with the answer it received.

import type { DisplayFrame, TranscriptLine } from "./envelope.ts";

export const DEFAULT_DESTRUCTIVE_TOOL_CALL_ID = "call_spike_2";

export function parseTranscript(jsonl: string, scenario: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.scenario !== scenario) continue;
    if (typeof parsed.seq !== "number") continue;
    const frame = parsed.frame;
    if (typeof frame !== "object" || frame === null) continue;
    lines.push({ seq: parsed.seq, frame: frame as Record<string, unknown> });
  }
  return lines.sort((a, b) => a.seq - b.seq);
}

type PiFrame = Record<string, unknown>;

function resultOutput(frame: PiFrame): string {
  const result = frame.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const parts = result?.content ?? [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

export function* displayFrames(
  lines: TranscriptLine[],
  opts: { destructiveToolCallId: string; approvalId?: string },
): Generator<DisplayFrame, void, void> {
  let seq = 0;
  let turn = 0;
  const commands = new Map<string, string>();
  const emit = (frame: Omit<DisplayFrame, "seq">): DisplayFrame => {
    seq += 1;
    return { seq, ...frame } as DisplayFrame;
  };

  for (const line of lines) {
    const frame = line.frame;
    const type = frame.type;
    if (type === "turn_start") {
      turn += 1;
      yield emit({ type: "turn_start", payload: { turn } });
    } else if (type === "message_update") {
      const event = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        yield emit({ type: "message_delta", payload: { text: event.delta } });
      }
    } else if (type === "tool_execution_start") {
      const toolCallId = String(frame.toolCallId);
      const command = `${String(frame.toolName)} ${JSON.stringify(frame.args ?? {})}`;
      commands.set(toolCallId, command);
      yield emit({
        type: "tool_call",
        payload: {
          toolCallId,
          toolName: String(frame.toolName),
          command,
          destructive: toolCallId === opts.destructiveToolCallId,
        },
      });
    } else if (type === "tool_execution_end") {
      const toolCallId = String(frame.toolCallId);
      const command = commands.get(toolCallId) ?? String(frame.toolName);
      if (toolCallId === opts.destructiveToolCallId) {
        const approvalId = opts.approvalId ?? `ap-${toolCallId}`;
        yield emit({
          type: "approval_request",
          payload: { approvalId, toolCallId, command },
        });
        yield emit({ type: "approval_resolved", payload: { approvalId, decision: null } });
      }
      yield emit({
        type: "tool_result",
        payload: {
          toolCallId,
          ok: frame.isError !== true,
          denied: false,
          output: resultOutput(frame),
          durationMs: typeof frame.durationMs === "number" ? frame.durationMs : null,
        },
      });
    } else if (type === "turn_end") {
      yield emit({ type: "turn_end", payload: { turn } });
    }
  }
  yield emit({ type: "stream_end", payload: {} });
}
