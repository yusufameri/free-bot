// The page's state machine over the seq-ordered display stream.
// Dense seq is the contract: a gap throws, an already-seen seq is counted and dropped.

import type { ApprovalCard, DisplayFrame, StreamState, ToolCard } from "./envelope.ts";

export function initialState(): StreamState {
  return {
    lastSeq: 0,
    frameCount: 0,
    duplicatesIgnored: 0,
    frames: [],
    turns: [],
    toolCards: [],
    approvals: [],
    awaitingApproval: false,
    done: false,
    resumedFrom: null,
    error: null,
  };
}

export function markResumed(state: StreamState, fromSeq: number): StreamState {
  return { ...state, resumedFrom: fromSeq };
}

export function markError(state: StreamState, message: string): StreamState {
  return { ...state, error: message };
}

function sameToolCard(card: ToolCard, toolCallId: string): boolean {
  return card.toolCallId === toolCallId;
}

export function applyFrame(state: StreamState, frame: DisplayFrame): StreamState {
  if (frame.seq <= state.lastSeq) {
    if (state.frames.some((seen) => seen.seq === frame.seq)) {
      return { ...state, duplicatesIgnored: state.duplicatesIgnored + 1 };
    }
    throw new Error(`out of order: seq ${frame.seq} already passed but was never seen`);
  }
  if (frame.seq !== state.lastSeq + 1) {
    throw new Error(`gap: expected seq ${state.lastSeq + 1}, got ${frame.seq}`);
  }
  const next: StreamState = {
    ...state,
    lastSeq: frame.seq,
    frameCount: state.frameCount + 1,
    frames: [...state.frames, frame],
  };
  switch (frame.type) {
    case "turn_start":
      next.turns = [...state.turns, frame.payload.turn];
      break;
    case "tool_call":
      next.toolCards = [
        ...state.toolCards,
        {
          toolCallId: frame.payload.toolCallId,
          toolName: frame.payload.toolName,
          command: frame.payload.command,
          destructive: frame.payload.destructive,
          status: frame.payload.destructive ? "awaiting approval" : "running",
          output: null,
          durationMs: null,
          callSeq: frame.seq,
          resultSeq: null,
        },
      ];
      break;
    case "approval_request": {
      const card: ApprovalCard = {
        approvalId: frame.payload.approvalId,
        toolCallId: frame.payload.toolCallId,
        command: frame.payload.command,
        decision: null,
        requestSeq: frame.seq,
        resolvedSeq: null,
      };
      next.approvals = [...state.approvals, card];
      next.awaitingApproval = true;
      break;
    }
    case "approval_resolved": {
      const approval = state.approvals.find((card) => card.approvalId === frame.payload.approvalId);
      next.approvals = state.approvals.map((card) =>
        card.approvalId === frame.payload.approvalId
          ? { ...card, decision: frame.payload.decision, resolvedSeq: frame.seq }
          : card,
      );
      if (frame.payload.decision !== null) {
        next.awaitingApproval = false;
        const status: ToolCard["status"] =
          frame.payload.decision === "allow" ? "running" : "denied";
        next.toolCards = state.toolCards.map((card) =>
          card.toolCallId === approval?.toolCallId ? { ...card, status } : card,
        );
      }
      break;
    }
    case "tool_result":
      next.toolCards = state.toolCards.map((card) =>
        sameToolCard(card, frame.payload.toolCallId)
          ? {
              ...card,
              status: frame.payload.denied ? "denied" : "done",
              output: frame.payload.denied ? null : frame.payload.output,
              durationMs: frame.payload.durationMs,
              resultSeq: frame.seq,
            }
          : card,
      );
      break;
    case "stream_end":
      next.done = true;
      break;
    default:
      break;
  }
  return next;
}
