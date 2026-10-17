/**
 * The tunnel wire and the one seq.
 *
 * Frames are stamped with their seq once, by their origin: the sandbox supervisor, the single
 * reader of Pi's stdout. The control plane appends them to one event log in exactly that order.
 * Every rejoin (the agent after a tunnel death, a client after a dropped stream) names a
 * `last_seen_seq` and receives exactly the frames after it.
 */

/** One frame with its place in the single monotonic sequence. */
export interface SeqFrame<TFrame = unknown> {
  seq: number;
  frame: TFrame;
}

/** Sandbox agent -> control plane: one stamped frame. */
export interface TunnelFrameMessage<TFrame = unknown> extends SeqFrame<TFrame> {
  kind: "frame";
}

/** Control plane -> sandbox agent. */
export type TunnelControlMessage =
  /** Everything up to `seq` is in the log; the agent can drop its replay buffer below it. */
  | { kind: "ack"; seq: number }
  /** A gap: seqs after `lastSeq` are missing; the agent must resend them. */
  | { kind: "nack"; lastSeq: number }
  /** A refused tunnel message: malformed JSON, a truncated frame, or a non-seq. */
  | { kind: "error"; message: string };

/** Control plane -> client: the stream leg. */
export type StreamMessage<TFrame = unknown> =
  | { kind: "hello"; lastSeq: number }
  | TunnelFrameMessage<TFrame>;

export type TunnelMessage<TFrame = unknown> = TunnelFrameMessage<TFrame> | TunnelControlMessage;
