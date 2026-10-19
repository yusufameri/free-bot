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
  /**
   * Per tool-call card, in DOM order: whether its `.output-details` collapsible is unhidden, so the
   * card's literal output is on the page rather than behind a closed disclosure.
   */
  outputShown: boolean[];
  /** Per approval card: `"allow"`, `"deny"`, `"expired"`, or `null` while the card waits. */
  approvals: Array<string | null>;
  /** Assistant text, one entry per delta node. */
  deltas: string[];
  /** Per approval card, in DOM order: the item-level state its own head and tag carry. */
  approvalStates: ApprovalItemState[];
  /** Per tool card, in DOM order: the item-level state its own tag and output carry. */
  toolStates: ToolItemState[];
  /** Per turn marker, in DOM order: the phase its own text names. */
  turnPhases: TurnItemState[];
  /** Per turn marker, in DOM order: the literal line under the pulse. */
  turnTexts: string[];
  /** Every rendered frame's seq, so a transcript that rendered a message twice is visible. */
  renderedSeqs: number[];
  /** The seqs that appear on more than one rendered frame. Empty is the invariant. */
  duplicateSeqs: number[];
  /**
   * The marker lines this unit removed. Each is a census over the transcript, so a marker that
   * returns to duplicate a card fails the frame rather than passing unnoticed.
   */
  removedMarkers: {
    turnTitle: number;
    turnEnd: number;
    toolDecision: number;
    toolResult: number;
    approvalResolved: number;
    runStatus: number;
    grantLifecycle: number;
  };
  /** The resume banner's `fromSeq`, or null when no banner is shown. */
  resume: number | null;
  streamEnd: string | null;
}

/** The four states a tool card's own tag can show. */
export const TOOL_ITEM_STATES = ["running", "done", "denied", "failed"] as const;

export type ToolItemState = (typeof TOOL_ITEM_STATES)[number];

/** The four states an approval card's own head can show, in the export's order. */
export const APPROVAL_ITEM_STATES = ["pending", "allowed", "denied", "expired"] as const;

export type ApprovalItemState = (typeof APPROVAL_ITEM_STATES)[number];

/** The three lines the turn marker is allowed to say. */
export const TURN_ITEM_STATES = ["thinking", "working", "waiting"] as const;

export type TurnItemState = (typeof TURN_ITEM_STATES)[number];

/** The turn marker's copy, which is FreeBot's own (`UX.md:115`, `:132`). */
export const TURN_ITEM_TEXT: Record<TurnItemState, string> = {
  thinking: "Thinking it through",
  working: "Working on your computer",
  waiting: "Waiting on results",
};

/**
 * What a tool card shows once its result lands. `denied` is the gate's refusal, which never ran;
 * `failed` is a call that ran and reported a non-zero outcome. Both are distinct from `done`, which
 * is the only state where an output block is the command's own stdout.
 */
export function toolItemState(result: { denied: boolean; ok: boolean }): ToolItemState {
  if (result.denied) return "denied";
  return result.ok ? "done" : "failed";
}

/** What an approval card shows once it is answered, or before anything answered it. */
export function approvalItemState(input: {
  decision: "allow" | "deny" | "expired" | null;
}): ApprovalItemState {
  if (input.decision === "allow") return "allowed";
  if (input.decision === "deny") return "denied";
  if (input.decision === "expired") return "expired";
  return "pending";
}

/** The card a run's ending closes: a request nobody answered is `expired`, never `denied`. */
export function approvalStateAfterRunEnd(input: {
  decision: "allow" | "deny" | "expired" | null;
}): ApprovalItemState {
  return input.decision === null ? "expired" : approvalItemState(input);
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
  const outputs = facts.outputShown.map((shown) => (shown ? "open" : "closed")).join(",");
  const approvals = facts.approvals.map((decision) => decision ?? "pending").join(",");
  return [
    `last seq ${facts.lastSeq}`,
    `done ${facts.done}`,
    `turns ${facts.turns}`,
    `cards [${cards}]`,
    `output blocks [${outputs}]`,
    `approvals [${approvals}]`,
    `resume ${facts.resume ?? "-"}`,
    `stream end ${facts.streamEnd ?? "-"}`,
    `text "${facts.deltas.at(-1) ?? ""}"`,
  ].join(" · ");
}

/** The item-level line, one per card and marker, for the items artifact. */
export function describeItems(facts: FrameFacts): string {
  return [
    `approvals [${facts.approvalStates.join(",")}]`,
    `tools [${facts.toolStates.join(",")}]`,
    `turns [${facts.turnPhases.map((phase) => `${phase}:${TURN_ITEM_TEXT[phase]}`).join(",")}]`,
    `removed [${Object.entries(facts.removedMarkers)
      .map(([name, count]) => `${name}:${count}`)
      .join(",")}]`,
    `rendered seqs ${facts.renderedSeqs.length}, duplicates [${facts.duplicateSeqs.join(",")}]`,
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
      "Reconnected after the stream dropped: the resume banner names the last seq the page had, and no rendered frame carries a seq twice.",
    claims: [
      { label: "the resume banner is shown", holds: (f) => f.resume !== null },
      {
        label: "no rendered frame repeats another frame's seq",
        holds: (f) => f.duplicateSeqs.length === 0,
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
    caption:
      "The run finished: no message rendered twice, every tool card's output in a collapsible block, the terminal marker on screen, and no card left running.",
    claims: [
      { label: "the run reported done", holds: (f) => f.done },
      { label: "the terminal marker is rendered", holds: (f) => f.streamEnd === "stream complete" },
      {
        label: "no rendered frame repeats another frame's seq",
        holds: (f) => f.duplicateSeqs.length === 0,
      },
      {
        label: "every tool card's output in a collapsible block",
        holds: (f) =>
          f.cards.length > 0 &&
          f.outputShown.length === f.cards.length &&
          f.outputShown.every((shown) => shown),
      },
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

function noMarkerLines(facts: FrameFacts): boolean {
  return Object.values(facts.removedMarkers).every((count) => count === 0);
}

/**
 * The item states this unit owns, one spec per state a person can meet. These are the acceptance's
 * inventory rather than the older eight-frame tour: four approval states, four tool-card states and
 * the three turn-marker phases. `items.ts` captures one PNG per spec and evaluates its claims
 * against the live DOM facts, the same rule `FRAME_SPECS` follows.
 */
export const ITEM_SPECS: readonly FrameSpec[] = [
  {
    name: "approval-pending",
    caption:
      "An approval card waits: the head says Approval needed, the tag says pending, and both answers are live.",
    claims: [
      {
        label: "exactly one approval card is pending",
        holds: (f) => f.approvalStates.filter((state) => state === "pending").length === 1,
      },
      {
        label: "the governed tool card still waits",
        holds: (f) => hasStatus(f, "awaiting approval"),
      },
      { label: "no duplicate marker line", holds: noMarkerLines },
    ],
    visible: '#thread .approval-card[data-state="pending"]',
  },
  {
    name: "approval-allowed",
    caption:
      "Allowed once: the head says Allowed once, the tag says allowed, and the card carries the decision instead of buttons.",
    claims: [
      { label: "one approval card is allowed", holds: (f) => f.approvalStates.includes("allowed") },
      {
        label: "no approval is still pending",
        holds: (f) => !f.approvalStates.includes("pending"),
      },
      { label: "no duplicate marker line", holds: noMarkerLines },
    ],
    visible: '#thread .approval-card[data-state="allowed"]',
  },
  {
    name: "approval-denied",
    caption:
      "Denied: the head says Denied, the tag says denied, and the card records the refusal rather than an output.",
    claims: [
      { label: "one approval card is denied", holds: (f) => f.approvalStates.includes("denied") },
      { label: "no duplicate marker line", holds: noMarkerLines },
    ],
    visible: '#thread .approval-card[data-state="denied"]',
  },
  {
    name: "approval-expired",
    caption:
      "Expired: the window passed unanswered, the head says Expired, and the tag says expired.",
    claims: [
      { label: "one approval card is expired", holds: (f) => f.approvalStates.includes("expired") },
      {
        label: "no approval is still pending",
        holds: (f) => !f.approvalStates.includes("pending"),
      },
      {
        label: "no tool card is still running",
        holds: (f) => !f.toolStates.includes("running"),
      },
      { label: "no duplicate marker line", holds: noMarkerLines },
    ],
    visible: '#thread .approval-card[data-state="expired"]',
  },
  {
    name: "tool-running",
    caption:
      "A tool call runs: the card says Tool call, its tag says pending, and the command sits in the code block.",
    claims: [
      {
        label: "one tool card is running",
        holds: (f) => f.toolStates.filter((state) => state === "running").length >= 1,
      },
      {
        label: "the running card has not shown an output",
        holds: (f) =>
          f.toolStates.some(
            (state, index) => state === "running" && f.outputShown[index] === false,
          ),
      },
      { label: "no duplicate result marker", holds: noMarkerLines },
    ],
    visible: '#thread .tool-card[data-status="running"]',
  },
  {
    name: "tool-done",
    caption:
      "A tool call finished: the tag says done, the dot is filled, and its output block is open.",
    claims: [
      { label: "one tool card is done", holds: (f) => f.toolStates.includes("done") },
      {
        label: "the done card's output is open",
        holds: (f) =>
          f.toolStates.some((state, index) => state === "done" && f.outputShown[index] === true),
      },
      { label: "no duplicate result marker", holds: noMarkerLines },
    ],
    visible: '#thread .tool-card[data-status="done"]',
  },
  {
    name: "tool-denied",
    caption:
      "A tool call was denied: the tag says denied, the dot is a ring, and no output block is offered.",
    claims: [
      { label: "one tool card is denied", holds: (f) => f.toolStates.includes("denied") },
      {
        label: "the denied card shows no output",
        holds: (f) =>
          f.toolStates.some((state, index) => state === "denied" && f.outputShown[index] === false),
      },
      { label: "no duplicate decision marker", holds: noMarkerLines },
    ],
    visible: '#thread .tool-card[data-status="denied"]',
  },
  {
    name: "tool-failed",
    caption:
      "A tool call ran and failed: the tag says failed, the dot is a ring, and its error output is open.",
    claims: [
      { label: "one tool card is failed", holds: (f) => f.toolStates.includes("failed") },
      {
        label: "the failed card's output is open",
        holds: (f) =>
          f.toolStates.some((state, index) => state === "failed" && f.outputShown[index] === true),
      },
      { label: "no duplicate result marker", holds: noMarkerLines },
    ],
    visible: '#thread .tool-card[data-status="failed"]',
  },
  {
    name: "turn-thinking",
    caption: "The turn marker says Thinking it through while the Bot composes its answer.",
    claims: [
      {
        label: "a turn marker says Thinking it through",
        holds: (f) => f.turnTexts.includes("Thinking it through"),
      },
      {
        label: "no turn-title marker duplicates it",
        holds: (f) => f.removedMarkers.turnTitle === 0,
      },
      { label: "no turn-end line duplicates it", holds: (f) => f.removedMarkers.turnEnd === 0 },
    ],
    visible: '#thread .tm[data-phase="thinking"]',
  },
  {
    name: "turn-working",
    caption:
      "The turn marker says Working on your computer while a call runs or waits at the gate.",
    claims: [
      {
        label: "a turn marker says Working on your computer",
        holds: (f) => f.turnTexts.includes("Working on your computer"),
      },
      { label: "no duplicate turn marker line", holds: noMarkerLines },
    ],
    visible: '#thread .tm[data-phase="working"]',
  },
  {
    name: "turn-waiting",
    caption: "The turn marker says Waiting on results after a call's result has landed.",
    claims: [
      {
        label: "a turn marker says Waiting on results",
        holds: (f) => f.turnTexts.includes("Waiting on results"),
      },
      { label: "one marker per turn", holds: (f) => f.turnTexts.length === f.turns },
    ],
    visible: '#thread .tm[data-phase="waiting"]',
  },
];

/** One Bot-row state, evaluated against the shell's own facts. */
export interface BotItemSpec {
  readonly name: string;
  readonly caption: string;
  readonly visible: string;
  readonly holds: (facts: import("./bots.ts").ShellFacts, botId: string) => boolean;
}

/**
 * The four Bot-row states. The dot and the sub line are the export's, and each is derived from the
 * Bot's runs: working while one is in flight, needs you while an approval is parked, failed when the
 * newest run failed, idle otherwise.
 */
export const BOT_ITEM_SPECS: readonly BotItemSpec[] = [
  {
    name: "bot-working",
    caption: "The Bot row pulses and says working while one of its runs is in flight.",
    visible: "#bot-list .sb-row[data-state='working']",
    holds: (facts, botId) =>
      facts.bots.some(
        (bot) =>
          bot.botId === botId &&
          bot.status === "working" &&
          bot.sub === "working" &&
          bot.dot === "pulse",
      ),
  },
  {
    name: "bot-needs-you",
    caption: "The Bot row's dot is filled and says needs you while an approval is parked.",
    visible: "#bot-list .sb-row[data-state='attention']",
    holds: (facts, botId) =>
      facts.bots.some(
        (bot) =>
          bot.botId === botId &&
          bot.status === "attention" &&
          bot.sub === "needs you" &&
          bot.dot === "dot on",
      ),
  },
  {
    name: "bot-failed",
    caption: "The Bot row's dot is a ring and its name is muted after its newest run failed.",
    visible: "#bot-list .sb-row[data-state='failed']",
    holds: (facts, botId) =>
      facts.bots.some(
        (bot) =>
          bot.botId === botId &&
          bot.status === "failed" &&
          bot.sub === "failed" &&
          bot.dot === "dot ring",
      ),
  },
  {
    name: "bot-idle",
    caption:
      "The Bot row's dot is empty and its sub line falls back to the role once nothing is in flight.",
    visible: "#bot-list .sb-row[data-state='idle']",
    holds: (facts, botId) =>
      facts.bots.some((bot) => bot.botId === botId && bot.status === "idle" && bot.dot === "dot"),
  },
];
