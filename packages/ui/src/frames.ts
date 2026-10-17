/**
 * The committed-frame contract: what each key-state frame must actually show, and the guard that
 * two frames never document the same page.
 *
 * Distinct PNG bytes are not evidence. The bytes vary run to run (timestamped filenames,
 * antialiasing, a taller scrollbar), so a capture that loses its race with the next state can ship
 * as a differently-sized file that shows the same page. U0.11 caught `06-denied` doing exactly
 * that. Distinctness is therefore checked pairwise over the facts read from the live DOM at capture
 * time, and a caption is not prose a reader has to trust: each caption's claims are `FrameSpec`
 * predicates evaluated against those same facts, so a caption naming a state the frame does not
 * show fails the run.
 */

/** What a user could see, read from the live page at capture time. */
export interface FrameFacts {
  lastSeq: number;
  done: boolean;
  frameCount: number;
  turns: number;
  /** `[toolCallId, status]` per tool-call card, in DOM order. */
  cards: Array<[string, string]>;
  /** Per approval card: `"allow"`, `"deny"`, or `null` while the card waits. */
  approvals: Array<string | null>;
  /** Assistant text, one entry per delta node. */
  deltas: string[];
  /** The resume banner's `fromSeq`, or null when no banner is shown. */
  resume: number | null;
  streamEnd: string | null;
}

export interface Capture {
  name: string;
  file: string;
  bytes: number;
  sha256: string;
  facts: FrameFacts;
}

/** One claim a caption makes, as something a reader of the frame could check. */
export interface FrameClaim {
  label: string;
  holds: (facts: FrameFacts) => boolean;
}

export interface FrameSpec {
  /** Capture name, matching the `NN-state` prefix of the committed file. */
  name: string;
  /** One line for the PR body. Every claim in it is one of `claims`. */
  caption: string;
  claims: FrameClaim[];
  /**
   * The element the caption is about. The harness scrolls to it and fails unless its box lands
   * inside the captured viewport, so the frame's pixels contain the state the caption names
   * rather than a scrolled-past thread that merely computes the right facts.
   */
  visible: string;
}

/** The facts as one comparable key. The frame's name is not part of the page's state. */
export function factsKey(facts: FrameFacts): string {
  return JSON.stringify(facts);
}

/** Every pair of captures that recorded the same page state, as `03-tool-running/04-resumed`. */
export function collapsedPairs(captures: readonly Capture[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index < captures.length; index += 1) {
    for (let other = index + 1; other < captures.length; other += 1) {
      const left = captures[index];
      const right = captures[other];
      if (left === undefined || right === undefined) continue;
      if (factsKey(left.facts) === factsKey(right.facts)) pairs.push(`${left.name}/${right.name}`);
    }
  }
  return pairs;
}

/** The claims of one spec that the captured facts do not support. Empty means the caption holds. */
export function unmetClaims(spec: FrameSpec, facts: FrameFacts): string[] {
  return spec.claims.filter((claim) => !claim.holds(facts)).map((claim) => claim.label);
}

/** One readable line for the artifact, so a reader can see what each frame documented. */
export function describeFacts(facts: FrameFacts): string {
  const cards = facts.cards.map(([call, status]) => `${call}:${status}`).join(" ");
  const approvals = facts.approvals.map((decision) => decision ?? "pending").join(",");
  return [
    `last seq ${facts.lastSeq}`,
    `done ${facts.done}`,
    `turns ${facts.turns}`,
    `cards [${cards}]`,
    `approvals [${approvals}]`,
    `resume ${facts.resume ?? "-"}`,
    `stream end ${facts.streamEnd ?? "-"}`,
    `text "${facts.deltas.at(-1) ?? ""}"`,
  ].join(" · ");
}

function hasStatus(facts: FrameFacts, status: string): boolean {
  return facts.cards.some(([, found]) => found === status);
}

/**
 * The eight key states (the brief's inventory: idle, streaming, tool-card-running,
 * approval-pending, post-approval, denied, resumed-after-kill, done). The order is the capture
 * order, which is the order a reader meets them in the run.
 */
export const FRAME_SPECS: readonly FrameSpec[] = [
  {
    name: "01-idle",
    caption: "Connected, no message rendered yet, and the stream has not started.",
    claims: [
      { label: "no message is rendered", holds: (f) => f.frameCount === 0 },
      { label: "no resume banner", holds: (f) => f.resume === null },
      { label: "the run has not finished", holds: (f) => !f.done },
    ],
    visible: "#idle-note",
  },
  {
    name: "02-streaming",
    caption: "Assistant text arriving token by token, before the first tool call is announced.",
    claims: [
      { label: "assistant text has begun", holds: (f) => f.deltas.length > 0 },
      { label: "no tool call has been announced yet", holds: (f) => f.cards.length === 0 },
      { label: "no approval is pending", holds: (f) => f.approvals.length === 0 },
      { label: "the run has not finished", holds: (f) => !f.done },
    ],
    visible: "#thread .delta",
  },
  {
    name: "03-tool-running",
    caption:
      "A tool-call card is running: the command and its args are shown, the result has not arrived.",
    claims: [
      { label: "a tool card shows running", holds: (f) => hasStatus(f, "running") },
      {
        label: "no card has produced a result yet",
        holds: (f) => f.cards.every(([, status]) => status === "running" || status === "requested"),
      },
      { label: "no approval is pending", holds: (f) => f.approvals.length === 0 },
      { label: "the run has not finished", holds: (f) => !f.done },
    ],
    visible: "#thread .tool-card",
  },
  {
    name: "04-resumed-after-kill",
    caption:
      "Reconnected after the stream dropped: the resume banner names the last seq the page had, and the replayed seq did not render twice.",
    claims: [
      { label: "the resume banner is shown", holds: (f) => f.resume !== null },
      {
        label: "one rendered message per seq (no double render)",
        holds: (f) => f.frameCount === f.lastSeq,
      },
      { label: "the run has not finished", holds: (f) => !f.done },
    ],
    visible: "#resume",
  },
  {
    name: "05-approval-pending",
    caption:
      "A governed call is parked: the card waits, the approval card names the exact command, and the stream is frozen at the gate.",
    claims: [
      {
        label: "one approval card is waiting",
        holds: (f) => f.approvals.length === 1 && f.approvals[0] === null,
      },
      {
        label: "the governed card waits for the answer",
        holds: (f) => hasStatus(f, "awaiting approval"),
      },
      { label: "the run has not finished", holds: (f) => !f.done },
    ],
    visible: "#thread .approval-card",
  },
  {
    name: "06-post-approval",
    caption:
      "Allowed once: the approval card shows the decision, the grant is issued, and the governed call is running.",
    claims: [
      {
        label: "the approval card shows the allow decision",
        holds: (f) => f.approvals.includes("allow"),
      },
      {
        label: "the governed card is no longer waiting",
        holds: (f) => !hasStatus(f, "awaiting approval"),
      },
      { label: "no approval is still waiting", holds: (f) => !f.approvals.includes(null) },
      { label: "the run has not finished", holds: (f) => !f.done },
    ],
    visible: "#thread .approval-card",
  },
  {
    name: "07-done",
    caption: "The run finished: every message rendered once, the terminal marker is on screen.",
    claims: [
      { label: "the run reported done", holds: (f) => f.done },
      { label: "the terminal marker is rendered", holds: (f) => f.streamEnd === "stream complete" },
      { label: "one rendered message per seq", holds: (f) => f.frameCount === f.lastSeq },
      { label: "no card is left running", holds: (f) => !hasStatus(f, "running") },
    ],
    visible: "#thread .run-finished",
  },
  {
    name: "08-denied",
    caption:
      "Denied: the refusal is recorded on the approval card, the governed card shows denied with no output, and the run has not reached its end.",
    claims: [
      {
        label: "the approval card shows the deny decision",
        holds: (f) => f.approvals.includes("deny"),
      },
      { label: "a tool card shows denied", holds: (f) => hasStatus(f, "denied") },
      { label: "the run has not finished", holds: (f) => !f.done },
    ],
    visible: "#thread .approval-card",
  },
] as const;

export function specFor(name: string): FrameSpec {
  const spec = FRAME_SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no frame spec named ${name}`);
  return spec;
}
