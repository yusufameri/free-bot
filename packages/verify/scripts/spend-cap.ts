#!/usr/bin/env bun
/**
 * The spend cap's evidence run: the run loop consults `checkSpendCap` before each provider turn.
 *
 * No container, no model and no network take part. The provider port reports what a call settled,
 * exactly as the keyed adapter does, and the loop is the landed one. Three scenarios are driven:
 * a run whose settled total is over the cap is refused the next provider turn with the taxonomy's
 * `spend_cap`; an under-cap run is unaffected; and spending exactly the cap is still within it. A
 * fourth, uncapped run shows the check is the configured ceiling rather than a hard-coded one.
 *
 * Run from the repo root: bun packages/verify/scripts/spend-cap.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkSpendCap,
  costNanoUsd,
  type GatePort,
  type LogPort,
  nanoToUsd,
  type ProviderPort,
  type ProviderUsage,
  type RunLoopOutcome,
  RunStore,
  runRunLoop,
  type SandboxPort,
  SeqLog,
  type TokenCounts,
  type TokenPrices,
} from "@freebot/core";
import { type Message, parseMessage } from "@freebot/protocol";

const root = fileURLToPath(new URL("../../..", import.meta.url));

/** The prices every scenario prices a call with; the same table the core's own tests use. */
const PRICES: TokenPrices = {
  inputPerMTok: "3.00",
  outputPerMTok: "15.00",
  cacheReadPerMTok: "0.30",
  cacheWritePerMTok: "3.75",
};

const TOOLS = [{ name: "bash", description: "Run a shell command.", parameters: {} }];
const AT = 1_700_000_000_000;

const lines: string[] = [];
let checks = 0;
let failures = 0;

function say(text: string): void {
  lines.push(text);
  console.log(text);
}

function check(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  say(
    ok
      ? `PASS ${name}: ${JSON.stringify(actual)}`
      : `FAIL ${name}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`,
  );
}

function shell(command: string[]): string {
  const proc = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

/** One call's usage at the table above, so the cost is the core's own money arithmetic. */
function usageOf(input: number, output: number): ProviderUsage {
  const tokens: TokenCounts = { input, output, cacheRead: 0, cacheWrite: 0 };
  return {
    provider: "byok",
    model: "evidence-model",
    tokens,
    costNanoUsd: costNanoUsd(PRICES, tokens),
  };
}

function usageOfRun(store: RunStore, runId: string) {
  const record = store.get(runId);
  if (record === undefined) throw new Error(`no record for ${runId}`);
  return record.usage;
}

/** The loop's sandbox: it does nothing, and the one destroy is counted. */
function noSandbox(): { port: SandboxPort; destroys: () => number } {
  let destroys = 0;
  return {
    port: {
      async create() {},
      async execute(call) {
        return {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          ok: true,
          denied: false,
          output: "one\n",
          durationMs: 1,
        };
      },
      async destroy() {
        destroys += 1;
      },
    },
    destroys: () => destroys,
  };
}

/** The gate allows every call, so each scenario is about the cap and nothing else. */
const gate: GatePort = {
  async decide(call) {
    return { allow: true, actionHash: `evidence:${call.toolCallId}` };
  },
};

interface ScenarioResult {
  readonly outcome: RunLoopOutcome;
  readonly store: RunStore;
  readonly frames: Message[];
  readonly providerCalls: number;
  readonly destroys: number;
}

async function scenario(input: {
  readonly runId: string;
  /** One entry per scripted turn; `toolCalls` says whether that turn asks for a governed call. */
  readonly turns: Array<{ toolCalls: boolean }>;
  /** What each provider call settled, in call order. */
  readonly usage: Array<ProviderUsage | undefined>;
  readonly capNanoUsd?: number;
}): Promise<ScenarioResult> {
  const store = new RunStore({ now: () => AT });
  const seqLog = new SeqLog<Message>();
  const frames: Message[] = [];
  let seq = 0;
  const log: LogPort = {
    append(type, payload) {
      const next = seq + 1;
      const parsed = parseMessage({
        v: 1,
        seq: next,
        ts: AT + next,
        runId: input.runId,
        type,
        payload,
      });
      if (seqLog.append(next, parsed) !== "appended") throw new Error(`frame ${next} refused`);
      seq = next;
      frames.push(parsed);
      store.noteSeq(input.runId, next);
      return next;
    },
  };

  let providerCalls = 0;
  const provider: ProviderPort = {
    async next(turnInput) {
      providerCalls += 1;
      const turn = input.turns[providerCalls - 1];
      if (turn === undefined) throw new Error(`unscripted provider turn ${turnInput.turn}`);
      const usage = input.usage[providerCalls - 1];
      return {
        text: [],
        toolCalls: turn.toolCalls
          ? [
              {
                toolCallId: `call_${providerCalls}`,
                toolName: "bash",
                args: { command: "echo one" },
                destructive: true,
              },
            ]
          : [],
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };

  const sandbox = noSandbox();
  const outcome = await runRunLoop(
    {
      sandbox: sandbox.port,
      provider,
      gate,
      approvals: {
        async await() {
          throw new Error("this scenario never parks");
        },
      },
      store,
      log,
      now: () => AT,
      cancelled: () => false,
    },
    {
      runId: input.runId,
      threadId: "thread-spend-cap",
      botId: "bot-spend-cap",
      prompt: "spend one call",
      sandbox: { name: "spend-cap-evidence" },
      tools: TOOLS,
      ...(input.capNanoUsd === undefined ? {} : { spendCapNanoUsd: input.capNanoUsd }),
    },
  );

  return {
    outcome,
    store,
    frames,
    providerCalls,
    destroys: sandbox.destroys(),
  };
}

function statusTrail(frames: Message[]): string[] {
  return frames
    .filter((frame) => frame.type === "run.status")
    .map((frame) => (frame.type === "run.status" ? frame.payload.status : ""));
}

say("feature: spend-cap");
say("command: bun packages/verify/scripts/spend-cap.ts");
say(`git sha: ${shell(["git", "rev-parse", "HEAD"])}`);
say(`branch: ${shell(["git", "rev-parse", "--abbrev-ref", "HEAD"])}`);
say(`runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`);
say(
  "the loop is the landed one; the provider reports one call's tokens and cost; no model, no container, no network",
);

say("");
say("== the prices every scenario uses");
say(`  input ${PRICES.inputPerMTok} USD/Mtok, output ${PRICES.outputPerMTok} USD/Mtok`);
const oneThousand = usageOf(1_000, 0);
say(
  `  deterministic: 1,000 input tokens cost ${nanoToUsd(oneThousand.costNanoUsd)} USD (${oneThousand.costNanoUsd} nano-USD)`,
);

// ---------------------------------------------------------------------------
// Over the cap: the next provider turn is never made
// ---------------------------------------------------------------------------

say("");
say("== settled usage over the cap");
const over = await scenario({
  runId: "run-over",
  turns: [{ toolCalls: true }, { toolCalls: false }],
  usage: [oneThousand],
  capNanoUsd: 2_500_000,
});
const overError = over.store.get("run-over")?.error;
const overFailure = over.frames.find((frame) => frame.type === "run.failed");
const overUsage = usageOfRun(over.store, "run-over");
check("the run settled at failed, not done", over.outcome.status, "failed");
check(
  "the provider was called exactly once; the crossing turn's successor never happened",
  over.providerCalls,
  1,
);
check("the status trail names the one turn and the cap settlement", statusTrail(over.frames), [
  "running",
  "failed",
]);
check(
  "the taxonomy code is spend_cap and its detail carries both the spend and the cap",
  overError == null ? null : { code: overError.code, detail: overError.detail },
  {
    code: "spend_cap",
    detail: "settled spend 0.003 USD exceeded the cap 0.0025 USD by 0.0005 USD",
  },
);
check(
  "the run.failed frame carries the same reason",
  overFailure?.type === "run.failed" ? overFailure.payload.reason : null,
  "settled spend 0.003 USD exceeded the cap 0.0025 USD by 0.0005 USD",
);
check("the settled total is the one call's cost", overUsage.costNanoUsd, 3_000_000);
check("the sandbox was destroyed on the cap path", over.destroys, 1);
check(
  "the pre-call compare the loop consulted says over",
  checkSpendCap(overUsage, 2_500_000).ok,
  false,
);

// ---------------------------------------------------------------------------
// Under the cap: every turn the run needs is made
// ---------------------------------------------------------------------------

say("");
say("== settled usage under the cap");
const under = await scenario({
  runId: "run-under",
  turns: [{ toolCalls: true }, { toolCalls: false }],
  usage: [usageOf(1_000, 0), usageOf(1_000, 0)],
  capNanoUsd: 10_000_000,
});
check("the under-cap run finished", under.outcome.status, "done");
check("both provider turns were made", under.providerCalls, 2);
check(
  "the two turns' usage is the run's total",
  usageOfRun(under.store, "run-under").costNanoUsd,
  6_000_000,
);
check(
  "the usage ids are per turn, so a replay cannot count one twice",
  under.store.usageEvents("run-under").map((event) => event.usageId),
  ["run-under:turn-1", "run-under:turn-2"],
);
check(
  "no run.failed frame is in an under-cap run",
  under.frames.some((frame) => frame.type === "run.failed"),
  false,
);
check("the sandbox was destroyed on the done path", under.destroys, 1);

// ---------------------------------------------------------------------------
// Exactly the cap: still within it, and the boundary is the compare's
// ---------------------------------------------------------------------------

say("");
say("== settled usage exactly at the cap");
const exact = await scenario({
  runId: "run-exact",
  turns: [{ toolCalls: true }, { toolCalls: false }],
  usage: [usageOf(1_000, 0), usageOf(0, 0)],
  capNanoUsd: 3_000_000,
});
check("spending exactly the cap still allows the next turn", exact.outcome.status, "done");
check("the boundary run made both calls", exact.providerCalls, 2);
check("its total is exactly the cap", usageOfRun(exact.store, "run-exact").costNanoUsd, 3_000_000);
check(
  "the compare agrees: not over at equality",
  checkSpendCap(usageOfRun(exact.store, "run-exact"), 3_000_000).ok,
  true,
);

// ---------------------------------------------------------------------------
// No cap: the same spend is allowed, so the ceiling is the configured one
// ---------------------------------------------------------------------------

say("");
say("== no cap configured");
const uncapped = await scenario({
  runId: "run-uncapped",
  turns: [{ toolCalls: true }, { toolCalls: false }],
  usage: [usageOf(1_000, 0), usageOf(1_000, 0)],
});
check("an uncapped run with the same spend finishes", uncapped.outcome.status, "done");
check("and both turns were made", uncapped.providerCalls, 2);
check(
  "with the same total the capped run would have stopped at",
  usageOfRun(uncapped.store, "run-uncapped").costNanoUsd,
  6_000_000,
);

say("");
say(`checks: ${checks - failures}/${checks} PASS`);

const shortSha = shell(["git", "rev-parse", "--short", "HEAD"]);
const dir = join(root, "packages/verify/artifacts/spend-cap", shortSha);
mkdirSync(dir, { recursive: true });
const result = `RESULT: ${failures === 0 ? "PASS" : "FAIL"} (${checks - failures}/${checks})`;
writeFileSync(join(dir, "assert.txt"), [...lines, "", result, ""].join("\n"));

say(`artifact: packages/verify/artifacts/spend-cap/${shortSha}/assert.txt`);
console.log(result);
process.exitCode = failures === 0 ? 0 : 1;
