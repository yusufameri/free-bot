// Behavior tests for the frame contract: the pairwise-distinctness guard and the rule that a
// caption may not describe a state its frame does not show. Both were real defects in U0.11, whose
// denial frame had quietly become a second copy of the terminal one.

import { describe, expect, test } from "bun:test";
import type { ShellFacts } from "./bots.ts";
import {
  approvalItemState,
  approvalStateAfterRunEnd,
  BOT_ITEM_SPECS,
  type Capture,
  collapsedPairs,
  describeFacts,
  FRAME_SPECS,
  type FrameFacts,
  ITEM_SPECS,
  specFor,
  TOOL_ITEM_STATES,
  toolItemState,
  unmetClaims,
} from "./frames.ts";

/**
 * The intended shape of each key state, as facts the page would report. The live capture is what
 * the CDP harness asserts; this table exists so the spec logic and the distinctness guard are
 * testable without a browser. The item-level fields default to empty; the item specs carry their
 * own states below.
 */
type FrameFactsCore = Omit<
  FrameFacts,
  | "approvalStates"
  | "toolStates"
  | "turnPhases"
  | "turnTexts"
  | "renderedSeqs"
  | "duplicateSeqs"
  | "removedMarkers"
>;

const NO_MARKERS: FrameFacts["removedMarkers"] = {
  turnTitle: 0,
  turnEnd: 0,
  toolDecision: 0,
  toolResult: 0,
  approvalResolved: 0,
  runStatus: 0,
  grantLifecycle: 0,
};

function full(core: FrameFactsCore): FrameFacts {
  return {
    ...core,
    approvalStates: [],
    toolStates: [],
    turnPhases: [],
    turnTexts: [],
    renderedSeqs: [],
    duplicateSeqs: [],
    removedMarkers: { ...NO_MARKERS },
  };
}

const INTENDED_RAW: Array<[string, FrameFactsCore]> = [
  [
    "01-idle",
    {
      lastSeq: 0,
      done: false,
      frameCount: 0,
      turns: 0,
      cards: [],
      outputShown: [],
      approvals: [],
      deltas: [],
      resume: null,
      streamEnd: null,
    },
  ],
  [
    "02-streaming",
    {
      lastSeq: 8,
      done: false,
      frameCount: 8,
      turns: 1,
      cards: [],
      outputShown: [],
      approvals: [],
      deltas: ["turn-1-chunk-0 "],
      resume: null,
      streamEnd: null,
    },
  ],
  [
    "03-tool-running",
    {
      lastSeq: 10,
      done: false,
      frameCount: 10,
      turns: 1,
      cards: [["call_spike_1", "running"]],
      outputShown: [false],
      approvals: [],
      deltas: ["turn-1-chunk-0 "],
      resume: null,
      streamEnd: null,
    },
  ],
  [
    "04-resumed-after-kill",
    {
      lastSeq: 33,
      done: false,
      frameCount: 33,
      turns: 2,
      cards: [["call_spike_1", "done"]],
      outputShown: [true],
      approvals: [],
      deltas: ["turn-1-chunk-0 "],
      resume: 33,
      streamEnd: null,
    },
  ],
  [
    "05-approval-pending",
    {
      lastSeq: 55,
      done: false,
      frameCount: 55,
      turns: 2,
      cards: [
        ["call_spike_1", "done"],
        ["call_spike_2", "awaiting approval"],
      ],
      outputShown: [true, false],
      approvals: [null],
      deltas: ["turn-1-chunk-0 "],
      resume: 33,
      streamEnd: null,
    },
  ],
  [
    "06-post-approval",
    {
      lastSeq: 58,
      done: false,
      frameCount: 58,
      turns: 2,
      cards: [
        ["call_spike_1", "done"],
        ["call_spike_2", "running"],
      ],
      outputShown: [true, false],
      approvals: ["allow"],
      deltas: ["turn-1-chunk-0 "],
      resume: 33,
      streamEnd: null,
    },
  ],
  [
    "07-done",
    {
      lastSeq: 90,
      done: true,
      frameCount: 90,
      turns: 4,
      cards: [
        ["call_spike_1", "done"],
        ["call_spike_2", "done"],
        ["call_spike_3", "done"],
      ],
      outputShown: [true, true, true],
      approvals: ["allow"],
      deltas: ["spike exchange complete."],
      resume: 33,
      streamEnd: "stream complete",
    },
  ],
  [
    "08-denied",
    {
      lastSeq: 58,
      done: false,
      frameCount: 58,
      turns: 2,
      cards: [
        ["call_spike_1", "done"],
        ["call_spike_2", "denied"],
      ],
      outputShown: [true, false],
      approvals: ["deny"],
      deltas: ["turn-2-chunk-0 "],
      resume: null,
      streamEnd: null,
    },
  ],
];

const INTENDED: Array<[string, FrameFacts]> = INTENDED_RAW.map(([name, core]) => [
  name,
  full(core),
]);

function frame(name: string, facts: FrameFacts, bytes: number): Capture {
  return { name, file: `${name}-0.png`, bytes, sha256: "0".repeat(64), facts };
}

describe("collapsedPairs", () => {
  test("two frames that show the same page are reported, whatever their bytes", () => {
    const facts = INTENDED[6]?.[1];
    if (facts === undefined) throw new Error("missing intended facts");
    const captures = [frame("06-post-approval", facts, 110688), frame("07-done", facts, 110797)];
    expect(collapsedPairs(captures)).toEqual(["06-post-approval/07-done"]);
  });

  test("the intended key states are pairwise distinct", () => {
    const captures = INTENDED.map(([name, facts]) => frame(name, facts, 1));
    expect(collapsedPairs(captures)).toEqual([]);
  });

  test("frames differing only in the assistant text are still distinct", () => {
    const facts = INTENDED[1]?.[1];
    if (facts === undefined) throw new Error("missing intended facts");
    const captures = [
      frame("a", { ...facts, deltas: [...facts.deltas, "more"] }, 1),
      frame("b", facts, 2),
    ];
    expect(collapsedPairs(captures)).toEqual([]);
  });
});

describe("captions", () => {
  test("every intended key state satisfies its own caption's claims", () => {
    for (const [name, facts] of INTENDED) {
      expect([name, unmetClaims(specFor(name), facts)]).toEqual([name, []]);
    }
  });

  test("a caption naming a state the frame does not show reports the unmet claims", () => {
    const done = INTENDED[6]?.[1];
    if (done === undefined) throw new Error("missing intended facts");
    expect(unmetClaims(specFor("08-denied"), done)).toEqual([
      "the approval card shows the deny decision",
      "a tool card shows denied",
      "the run has not finished",
    ]);
  });

  test("the done caption fails when a finished card's output block is still closed", () => {
    const done = INTENDED[6]?.[1];
    if (done === undefined) throw new Error("missing intended facts");
    expect(unmetClaims(specFor("07-done"), { ...done, outputShown: [true, false, true] })).toEqual([
      "every tool card's output in a collapsible block",
    ]);
  });

  test("the pending caption fails on a frame whose approval is already decided", () => {
    const allowed = INTENDED[5]?.[1];
    if (allowed === undefined) throw new Error("missing intended facts");
    expect(unmetClaims(specFor("05-approval-pending"), allowed)).toEqual([
      "one approval card is waiting",
      "the governed card waits for the answer",
    ]);
  });
});

describe("describeFacts", () => {
  test("one readable line, literal", () => {
    const pending = INTENDED[4]?.[1];
    if (pending === undefined) throw new Error("missing intended facts");
    expect(describeFacts(pending)).toBe(
      'last seq 55 · done false · turns 2 · cards [call_spike_1:done call_spike_2:awaiting approval] · output blocks [open,closed] · approvals [pending] · resume 33 · stream end - · text "turn-1-chunk-0 "',
    );
  });
});

describe("the frame inventory", () => {
  test("eight named states, in capture order", () => {
    expect(FRAME_SPECS.map((spec) => spec.name)).toEqual(INTENDED.map(([name]) => name));
  });

  test("every spec carries at least one claim and a caption", () => {
    expect(
      FRAME_SPECS.map((spec) => [spec.name, spec.claims.length > 0, spec.caption.length > 0]),
    ).toEqual(FRAME_SPECS.map((spec) => [spec.name, true, true]));
  });
});

function itemFacts(patch: Partial<FrameFacts>): FrameFacts {
  return {
    ...full(
      INTENDED_RAW[0]?.[1] ?? {
        lastSeq: 0,
        done: false,
        frameCount: 0,
        turns: 0,
        cards: [],
        outputShown: [],
        approvals: [],
        deltas: [],
        resume: null,
        streamEnd: null,
      },
    ),
    ...patch,
  };
}

describe("the item states", () => {
  test("the inventory is four approval states, four tool states and three turn phases", () => {
    expect(ITEM_SPECS.map((spec) => spec.name)).toEqual([
      "approval-pending",
      "approval-allowed",
      "approval-denied",
      "approval-expired",
      "tool-running",
      "tool-done",
      "tool-denied",
      "tool-failed",
      "turn-thinking",
      "turn-working",
      "turn-waiting",
    ]);
  });

  test("each item spec's claims hold on facts that show that state", () => {
    const byName: Record<string, FrameFacts> = {
      "approval-pending": itemFacts({
        approvalStates: ["pending"],
        cards: [["call-1", "awaiting approval"]],
        outputShown: [false],
      }),
      "approval-allowed": itemFacts({ approvalStates: ["allowed"] }),
      "approval-denied": itemFacts({ approvalStates: ["denied"] }),
      "approval-expired": itemFacts({ approvalStates: ["expired"] }),
      "tool-running": itemFacts({ toolStates: ["running"], outputShown: [false] }),
      "tool-done": itemFacts({ toolStates: ["done"], outputShown: [true] }),
      "tool-denied": itemFacts({ toolStates: ["denied"], outputShown: [false] }),
      "tool-failed": itemFacts({ toolStates: ["failed"], outputShown: [true] }),
      "turn-thinking": itemFacts({
        turns: 1,
        turnTexts: ["Thinking it through"],
        turnPhases: ["thinking"],
      }),
      "turn-working": itemFacts({
        turns: 1,
        turnTexts: ["Working on your computer"],
        turnPhases: ["working"],
      }),
      "turn-waiting": itemFacts({
        turns: 1,
        turnTexts: ["Waiting on results"],
        turnPhases: ["waiting"],
      }),
    };
    for (const spec of ITEM_SPECS) {
      expect([spec.name, unmetClaims(spec, byName[spec.name] ?? itemFacts({}))]).toEqual([
        spec.name,
        [],
      ]);
    }
  });

  test("a duplicate marker line fails the state that removed it", () => {
    const withTitle = itemFacts({
      turns: 1,
      turnTexts: ["Thinking it through"],
      removedMarkers: { ...NO_MARKERS, turnTitle: 1 },
    });
    expect(unmetClaims(specForItem("turn-thinking"), withTitle)).toEqual([
      "no turn-title marker duplicates it",
    ]);
  });

  test("a tool result maps to done, denied or failed, never to running", () => {
    expect(TOOL_ITEM_STATES).toEqual(["running", "done", "denied", "failed"]);
    expect([
      toolItemState({ denied: false, ok: true }),
      toolItemState({ denied: true, ok: false }),
      toolItemState({ denied: false, ok: false }),
    ]).toEqual(["done", "denied", "failed"]);
  });

  test("an approval maps pending to allowed, denied or expired", () => {
    expect([
      approvalItemState({ decision: null }),
      approvalItemState({ decision: "allow" }),
      approvalItemState({ decision: "deny" }),
      approvalItemState({ decision: "expired" }),
    ]).toEqual(["pending", "allowed", "denied", "expired"]);
    expect(approvalStateAfterRunEnd({ decision: null })).toBe("expired");
    expect(approvalStateAfterRunEnd({ decision: "allow" })).toBe("allowed");
  });

  test("each Bot item state has the export's dot, sub line and derived status", () => {
    const base = INTENDED_RAW[0]?.[1];
    if (base === undefined) throw new Error("missing intended facts");
    const facts: ShellFacts = {
      operator: true,
      bots: [
        {
          botId: "bot-a",
          name: "Atlas",
          threadCount: 1,
          selected: true,
          status: "working",
          sub: "working",
          dot: "pulse",
        },
        {
          botId: "bot-b",
          name: "Patch",
          threadCount: 1,
          selected: false,
          status: "attention",
          sub: "needs you",
          dot: "dot on",
        },
        {
          botId: "bot-c",
          name: "Quill",
          threadCount: 1,
          selected: false,
          status: "failed",
          sub: "failed",
          dot: "dot ring",
        },
        {
          botId: "bot-d",
          name: "Ledger",
          threadCount: 1,
          selected: false,
          status: "idle",
          sub: "Finance",
          dot: "dot",
        },
      ],
      selectedBotId: "bot-a",
      threads: [],
      selectedThreadId: null,
      title: "Atlas",
    };
    expect(
      BOT_ITEM_SPECS.map((spec) => [
        spec.name,
        spec.holds(facts, facts.bots[BOT_ITEM_SPECS.indexOf(spec)]?.botId ?? ""),
      ]),
    ).toEqual(BOT_ITEM_SPECS.map((spec) => [spec.name, true]));
    expect(base.lastSeq).toBe(0);
  });
});

function specForItem(name: string): (typeof ITEM_SPECS)[number] {
  const spec = ITEM_SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no item spec named ${name}`);
  return spec;
}
