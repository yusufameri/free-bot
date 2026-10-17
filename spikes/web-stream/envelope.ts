// Display envelope for the web-stream spike (U0.10).
//
// The production protocol with zod schemas is T2's (`packages/protocol`). This is the
// spike-local shape: the stub maps recorded pi RPC frames into it, the page renders it.
// `docs/web-stream-spike.md` documents the transcript-to-envelope mapping.

export type ToolStatus = "running" | "awaiting approval" | "denied" | "done";

export type DisplayPayloads = {
  turn_start: { turn: number };
  message_delta: { text: string };
  tool_call: {
    toolCallId: string;
    toolName: string;
    command: string;
    destructive: boolean;
  };
  tool_result: {
    toolCallId: string;
    ok: boolean;
    denied: boolean;
    output: string;
    durationMs: number | null;
  };
  approval_request: { approvalId: string; toolCallId: string; command: string };
  approval_resolved: { approvalId: string; decision: "allow" | "deny" | null };
  turn_end: { turn: number };
  stream_end: Record<string, never>;
};

export type DisplayType = keyof DisplayPayloads;

export type DisplayFrame = {
  [K in DisplayType]: { seq: number; type: K; payload: DisplayPayloads[K] };
}[DisplayType];

/** One seq-stamped pi RPC frame from the recorded transcript. */
export type TranscriptLine = { seq: number; frame: Record<string, unknown> };

export type ToolCard = {
  toolCallId: string;
  toolName: string;
  command: string;
  destructive: boolean;
  status: ToolStatus;
  output: string | null;
  durationMs: number | null;
  callSeq: number;
  resultSeq: number | null;
};

export type ApprovalCard = {
  approvalId: string;
  toolCallId: string;
  command: string;
  decision: "allow" | "deny" | null;
  requestSeq: number;
  resolvedSeq: number | null;
};

export type StreamState = {
  lastSeq: number;
  frameCount: number;
  duplicatesIgnored: number;
  frames: DisplayFrame[];
  turns: number[];
  toolCards: ToolCard[];
  approvals: ApprovalCard[];
  awaitingApproval: boolean;
  done: boolean;
  resumedFrom: number | null;
  error: string | null;
};
