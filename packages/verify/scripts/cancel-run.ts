#!/usr/bin/env bun
/**
 * The stop evidence driver: a run started from the page can be stopped from the page.
 *
 * A really launched `bun run up --no-open --replay` is the peer, over a `FREEBOT_HOME` and bots
 * root this driver made, with its own placeholder vault so the page opens on the shell rather than
 * the provider screen. The driver opens the URL the launcher printed in headless Chrome over CDP,
 * types a prompt into the page's own composer, waits for the recorded model's call to park at the
 * gate, and presses the page's own `Stop run` control. The run's terminal status is `cancelled`, the
 * transcript that arrived before the stop is still on the page, and the container the run held is
 * gone: the label-scoped census is back to its baseline while a decoy under another unit's label
 * survives.
 *
 * The model is the committed replay transcript, because this driver's subject is the stop and a
 * recorded turn keeps the parked state deterministic (order 9). Nothing is billed, no key is read,
 * and the placeholder vault's fake key is never printed or committed.
 *
 * Run from the repo root: bun packages/verify/scripts/cancel-run.ts
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_IMAGE } from "@freebot/sandbox";
import {
  type Cdp,
  evaluate,
  launchChrome,
  openPage,
  screenshot,
  settle,
  sleep,
  waitFor,
} from "../src/cdp.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "cancel-run";

/** The unit label the launcher's containers carry, from `apps/server/src/run-ports.ts`. */
const RUN_UNIT = "u1.7";
/** A label outside that unit, so the cleanup proof can show it is scoped. */
const DECOY_UNIT = "u10.3-decoy";

const PROMPT =
  "Use the bash tool to print today's date in the sandbox, then tell me what it printed.";

let artifactsDir = "";
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
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

function docker(args: string[]): string {
  return shell(["docker", ...args]);
}

function containersWith(filters: string[]): string[] {
  const raw = docker([
    "ps",
    "-a",
    ...filters.flatMap((filter) => ["--filter", filter]),
    "--format",
    "{{.Names}}",
  ]);
  return raw === ""
    ? []
    : raw
        .split("\n")
        .filter((name) => name.length > 0)
        .sort();
}

function runContainers(): string[] {
  return containersWith([`label=freebot.unit=${RUN_UNIT}`, "label=freebot.provider=docker"]);
}

function decoyContainers(): string[] {
  return containersWith([`label=freebot.unit=${DECOY_UNIT}`]);
}

const added = (before: readonly string[], after: readonly string[]): string[] =>
  after.filter((name) => !before.includes(name));

async function settles(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(150);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// The launched app
// ---------------------------------------------------------------------------

interface Launched {
  readonly url: string;
  readonly apiPort: number;
  readonly token: string;
  readonly home: string;
  readonly botsRoot: string;
  stdout(): string;
  stderr(): string;
  interrupt(): void;
  exited(): Promise<number>;
}

async function waitForMatch(read: () => string, match: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = match.exec(read());
    if (found?.[1] !== undefined) return found[1];
    await sleep(25);
  }
  throw new Error(`no line matching ${match} within ${timeoutMs}ms; saw:\n${read().slice(-1500)}`);
}

/** `bun run up --no-open --replay`, with a home and bots root this driver made. */
async function launch(): Promise<Launched> {
  const home = mkdtempSync(join(tmpdir(), "freebot-cancel-home-"));
  const botsRoot = join(home, "bots");
  writeFileSync(
    join(home, "provider.env"),
    [
      `# This driver's own placeholder vault, in a temporary directory: ${home}`,
      "# Nothing here is a real credential, and the run replays so no request is made.",
      `FREEBOT_BYOK_KEY=cancel-${Date.now()}`,
      "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/cancel-not-a-provider",
      "FREEBOT_BYOK_MODEL=cancel-placeholder",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const proc = Bun.spawn(["bun", "run", "up", "--no-open", "--replay"], {
    cwd: root,
    env: { ...process.env, FREEBOT_HOME: home, FREEBOT_WORKSPACE: botsRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let err = "";
  for (const [stream, keep] of [
    [proc.stdout, (text: string) => (out += text)],
    [proc.stderr, (text: string) => (err += text)],
  ] as const) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) keep(decoder.decode(chunk));
    })();
  }
  const url = await waitForMatch(() => out, /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m, 30_000);
  await waitForMatch(() => err, /tunnel on 127\.0\.0\.1:(\d+)/, 30_000);
  const parsed = new URL(url);
  return {
    url,
    apiPort: Number(parsed.port),
    token: new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "",
    home,
    botsRoot,
    stdout: () => out,
    stderr: () => err,
    interrupt: () => {
      proc.kill("SIGINT");
    },
    exited: () => proc.exited,
  };
}

function redacted(url: string): string {
  return url.replace(/#token=.*$/, "#token=<redacted>");
}

async function rpc(
  launch: Launched,
  procedure: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${launch.apiPort}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${launch.token}`,
      origin: `http://127.0.0.1:${launch.apiPort}`,
    },
    body: JSON.stringify({ json: input }),
  });
  return ((await response.json()) as { json: unknown }).json;
}

// ---------------------------------------------------------------------------
// The page's facts, read from the DOM
// ---------------------------------------------------------------------------

interface StopFacts {
  readonly frameCount: number;
  readonly lastSeq: number;
  readonly prompts: string[];
  readonly toolCards: Array<[string, string]>;
  readonly approvalDecisions: Array<string | null>;
  readonly runStatuses: string[];
  readonly headerStatus: string | null;
  readonly stop: {
    readonly label: string;
    readonly disabled: boolean;
    readonly inFlight: string;
    readonly runId: string | null;
    readonly stopping: string;
  };
  readonly text: string;
}

function facts(cdp: Cdp, page: string): Promise<StopFacts> {
  return evaluate<StopFacts>(
    cdp,
    page,
    `(() => {
      const frames = [...document.querySelectorAll('#thread .frame[data-seq]')];
      const stop = document.querySelector('#stop');
      return {
        frameCount: frames.length,
        lastSeq: Math.max(0, ...frames.map((node) => Number(node.dataset.seq))),
        prompts: [...document.querySelectorAll('#thread .message.user .prompt')].map((node) => node.textContent),
        toolCards: [...document.querySelectorAll('#thread .tool-card')].map((card) => [
          card.dataset.toolCall ?? '',
          card.querySelector('.status')?.textContent ?? '',
        ]),
        approvalDecisions: [...document.querySelectorAll('#thread .approval-card')].map(
          (card) => card.dataset.decision ?? null,
        ),
        runStatuses: [...document.querySelectorAll('#thread .run-status')].map(
          (node) => node.dataset.runStatus ?? '',
        ),
        headerStatus: document.querySelector('#run').dataset.runStatus ?? null,
        stop: {
          label: stop.textContent,
          disabled: stop.disabled,
          inFlight: stop.dataset.inFlight,
          runId: stop.dataset.runId ?? null,
          stopping: stop.dataset.stopping,
        },
        text: [...document.querySelectorAll('#thread .delta')].map((node) => node.textContent).join(''),
      };
    })()`,
  );
}

interface StopSpec {
  readonly name: string;
  readonly caption: string;
  readonly claims: Array<{ readonly label: string; readonly holds: (facts: StopFacts) => boolean }>;
  readonly visible: string;
}

/**
 * The three key states this unit adds. Each caption's claims are predicates over the facts read
 * from the live DOM at capture time, so a caption naming a state the frame does not show fails.
 */
const SPECS: readonly StopSpec[] = [
  {
    name: "01-no-run",
    caption:
      "A connected page with no run: the stop control is present, labelled Stop run, and disabled.",
    claims: [
      { label: "no message is rendered", holds: (f) => f.frameCount === 0 },
      { label: "the stop control names itself", holds: (f) => f.stop.label === "Stop run" },
      { label: "and is disabled", holds: (f) => f.stop.disabled },
      { label: "with no run in flight", holds: (f) => f.stop.inFlight === "false" },
    ],
    visible: "#stop",
  },
  {
    name: "02-in-flight",
    caption:
      "A run parked at the gate is in flight: Stop run is enabled, the page names the run, and the card that is waiting is still unanswered.",
    claims: [
      { label: "a run is in flight", holds: (f) => f.stop.inFlight === "true" },
      { label: "the stop control is enabled", holds: (f) => !f.stop.disabled },
      { label: "and names the run it will stop", holds: (f) => f.stop.runId === "run-1" },
      {
        label: "the prompt that started the run is on the page",
        holds: (f) => f.prompts.length === 1,
      },
      {
        label: "the governed call is waiting for an answer",
        holds: (f) => f.approvalDecisions.length === 1 && f.approvalDecisions[0] === null,
      },
      {
        label: "the run's own status frame says awaiting_approval",
        holds: (f) => f.runStatuses.includes("awaiting_approval"),
      },
    ],
    visible: "#stop",
  },
  {
    name: "03-cancelled",
    caption:
      "Stopped from the page: the run's terminal status is cancelled, the prompt and the call that arrived before the stop are still there, and the waiting approval is marked run stopped.",
    claims: [
      { label: "the run's status is cancelled", holds: (f) => f.headerStatus === "cancelled" },
      {
        label: "the terminal marker is rendered",
        holds: (f) => f.runStatuses.at(-1) === "cancelled",
      },
      { label: "the stop control is disabled again", holds: (f) => f.stop.disabled },
      { label: "and reports no run in flight", holds: (f) => f.stop.inFlight === "false" },
      {
        label: "the prompt that arrived before the stop is kept",
        holds: (f) => f.prompts.length === 1,
      },
      {
        label: "the tool card that arrived before the stop is kept",
        holds: (f) => f.toolCards.length === 1,
      },
      {
        label: "the waiting approval is no longer answerable",
        holds: (f) => f.approvalDecisions[0] === "cancelled",
      },
    ],
    visible: '#thread .run-status[data-run-status="cancelled"]',
  },
];

interface Capture {
  readonly name: string;
  readonly facts: StopFacts;
}

async function capture(cdp: Cdp, page: string, name: string): Promise<Capture> {
  const spec = SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no frame spec named ${name}`);
  await evaluate(
    cdp,
    page,
    `document.querySelector(${JSON.stringify(spec.visible)})?.scrollIntoView({ block: 'center' })`,
  );
  await settle(cdp, page);
  const before = await facts(cdp, page);
  const box = await evaluate<{ count: number; offscreen: number }>(
    cdp,
    page,
    `(() => {
      const rects = [...document.querySelectorAll(${JSON.stringify(spec.visible)})]
        .map((node) => node.getBoundingClientRect());
      return {
        count: rects.length,
        offscreen: rects.filter((rect) =>
          rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth
        ).length,
      };
    })()`,
  );
  const buffer = await screenshot(cdp, page);
  writeFileSync(join(artifactsDir, `${name}.png`), buffer);
  const after = await facts(cdp, page);

  check(
    `frame ${name}: the page held still across the capture`,
    JSON.stringify(before),
    JSON.stringify(after),
  );
  check(
    `frame ${name}: the element the caption is about is inside the captured pixels (${spec.visible})`,
    [box.count > 0, box.offscreen],
    [true, 0],
  );
  for (const claim of spec.claims) {
    check(`frame ${name}: claim - ${claim.label}`, claim.holds(after), true);
  }
  say(
    `frame ${name}: ${name}.png (${buffer.byteLength} bytes, sha256 ${createHash("sha256").update(buffer).digest("hex")}) - ${spec.caption}`,
  );
  return { name, facts: after };
}

async function main(): Promise<void> {
  const sha = shell(["git", "rev-parse", "--short", "HEAD"]);
  const full = shell(["git", "rev-parse", "HEAD"]);
  const branch = shell(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  artifactsDir = join(root, "packages", "verify", "artifacts", feature, sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  say(`feature: ${feature}`);
  say("command: bun packages/verify/scripts/cancel-run.ts");
  say(`timestamp: ${new Date().toISOString()}`);
  say(`git sha: ${full}`);
  say(`git sha short: ${sha}`);
  say(`branch: ${branch}`);
  say(`runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`);
  say("");

  if (Bun.spawnSync(["docker", "info"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) {
    throw new Error("Docker is not answering; this driver needs the pinned image");
  }

  const baseline = runContainers();
  say(
    `containers before the run (label freebot.unit=${RUN_UNIT}): ${baseline.length}${baseline.length === 0 ? "" : ` (${baseline.join(", ")})`}`,
  );

  const decoyName = `freebot-u103-decoy-${process.pid}`;
  const decoyCreated = Bun.spawnSync(
    [
      "docker",
      "create",
      "--name",
      decoyName,
      "--label",
      `freebot.unit=${DECOY_UNIT}`,
      PINNED_IMAGE.tag,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (decoyCreated.exitCode !== 0) {
    throw new Error(`could not create the decoy container: ${decoyCreated.stderr.toString()}`);
  }
  check("a decoy under another unit's label is up before the run", decoyContainers(), [decoyName]);

  const app = await launch();
  say(`the launcher's printed URL, redacted: ${redacted(app.url)}`);
  const boot = await waitForMatch(() => app.stderr(), /^(freebot up: spend cap .*)$/m, 30_000);
  say(`the launcher's cap line: ${boot}`);
  check(
    "the launch configures a per-run cap in the run path",
    [boot.includes("spend cap 5.00 USD per run"), boot.includes("no token prices configured")],
    [true, true],
  );

  const bot = (await rpc(app, "create_bot", { name: "Stop Check" })) as { botId: string };
  const thread = (await rpc(app, "create_thread", { botId: bot.botId })) as { threadId: string };
  say(`the Bot and thread the page opens on: ${bot.botId} / ${thread.threadId}`);

  const chrome = await launchChrome({ windowSize: "1280,1400" });
  try {
    const page = await openPage(chrome.cdp, app.url);
    await waitFor(
      chrome.cdp,
      page,
      "the page to connect",
      "document.querySelector('#conn').textContent === 'connected'",
    );
    await waitFor(
      chrome.cdp,
      page,
      "the operator composer and the stop control",
      "document.querySelector('#operator').hidden === false && document.querySelector('#stop') !== null",
    );
    await waitFor(
      chrome.cdp,
      page,
      "the shell to load a thread",
      "document.querySelector('#bot-title').textContent.length > 0",
    );

    const idle = await facts(chrome.cdp, page);
    check("with no run in flight the stop control is present, labelled and disabled", idle.stop, {
      label: "Stop run",
      disabled: true,
      inFlight: "false",
      runId: null,
      stopping: "false",
    });
    const captures: Capture[] = [];
    captures.push(await capture(chrome.cdp, page, "01-no-run"));

    await evaluate(
      chrome.cdp,
      page,
      `(() => {
        const input = document.querySelector('#prompt');
        input.value = ${JSON.stringify(PROMPT)};
        document.querySelector('#start').click();
      })()`,
    );
    await waitFor(
      chrome.cdp,
      page,
      "the recorded call to park at the gate",
      `[...document.querySelectorAll('#thread .approval-card')].some((card) => card.dataset.decision === undefined)`,
    );
    await waitFor(
      chrome.cdp,
      page,
      "the stop control to become enabled",
      "document.querySelector('#stop').disabled === false",
    );

    const parked = await facts(chrome.cdp, page);
    check("in flight, the stop control is enabled and names the run", parked.stop, {
      label: "Stop run",
      disabled: false,
      inFlight: "true",
      runId: "run-1",
      stopping: "false",
    });
    check(
      "the page names the run the prompt started",
      await evaluate<string>(chrome.cdp, page, "document.querySelector('#run').textContent"),
      "run run-1",
    );
    check(
      "the prompt the page sent is on the page",
      await evaluate<string>(
        chrome.cdp,
        page,
        "[...document.querySelectorAll('#thread .message.user .prompt')].at(-1).textContent",
      ),
      PROMPT,
    );
    check(
      "one governed call is on the page, waiting for the answer",
      parked.toolCards.map(([, status]) => status),
      ["awaiting approval"],
    );
    const during = runContainers();
    const live = added(baseline, during);
    check(
      "the in-flight run holds exactly one container, this launch's own",
      [live.length, during.length],
      [1, baseline.length + 1],
    );
    captures.push(await capture(chrome.cdp, page, "02-in-flight"));

    const beforeStop = await facts(chrome.cdp, page);
    await evaluate(chrome.cdp, page, "document.querySelector('#stop').click()");
    await waitFor(
      chrome.cdp,
      page,
      "the run's cancelled terminal status",
      "document.querySelector('#run').dataset.runStatus === 'cancelled'",
    );
    check(
      "the container the stop left is removed",
      await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
      true,
    );

    const stopped = await facts(chrome.cdp, page);
    check(
      "the terminal marker reads run cancelled",
      await evaluate<string>(
        chrome.cdp,
        page,
        `document.querySelector('#thread .run-status[data-run-status="cancelled"]').textContent`,
      ),
      "run cancelled",
    );
    check(
      "after the stop the control is disabled again and reports no run in flight",
      stopped.stop,
      {
        label: "Stop run",
        disabled: true,
        inFlight: "false",
        runId: "run-1",
        stopping: "true",
      },
    );
    check("the run's status frames end at cancelled", stopped.runStatuses.at(-1), "cancelled");
    check(
      "the page kept every frame that arrived before the stop",
      [stopped.frameCount >= beforeStop.frameCount, stopped.lastSeq >= beforeStop.lastSeq],
      [true, true],
    );
    check(
      "and the prompt that arrived before the stop is still there",
      stopped.prompts,
      beforeStop.prompts,
    );
    check(
      "and so is the tool card that arrived before the stop",
      stopped.toolCards,
      beforeStop.toolCards,
    );
    check(
      "the waiting approval is marked cancelled rather than allowed or denied",
      stopped.approvalDecisions,
      ["cancelled"],
    );
    check(
      "the composer is usable for the next run",
      await evaluate<boolean>(chrome.cdp, page, "document.querySelector('#start').disabled"),
      false,
    );
    check("the label-scoped census is back to its baseline", runContainers(), baseline);
    check("the decoy outside this unit's label survives the stop", decoyContainers(), [decoyName]);
    captures.push(await capture(chrome.cdp, page, "03-cancelled"));

    say("");
    say("== pairwise distinctness of the committed frames");
    const collisions: string[] = [];
    for (let index = 0; index < captures.length; index += 1) {
      for (let other = index + 1; other < captures.length; other += 1) {
        const left = captures[index];
        const right = captures[other];
        if (left === undefined || right === undefined) continue;
        if (JSON.stringify(left.facts) === JSON.stringify(right.facts)) {
          collisions.push(`${left.name}/${right.name}`);
        }
      }
    }
    check(
      "frames: every committed frame differs from every other in its page facts",
      collisions,
      [],
    );

    app.interrupt();
    check("the launcher exits zero on SIGINT", await app.exited(), 0);
    check(
      "nothing listens on the page port after the launch stops",
      shell(["lsof", "-nP", `-iTCP:${app.apiPort}`, "-sTCP:LISTEN"]) === "",
      true,
    );
    check(
      "the label-scoped census is still its baseline after the launch stops",
      runContainers(),
      baseline,
    );
  } finally {
    // A driver that failed an assertion still stops the app it started; the stop is idempotent.
    app.interrupt();
    await Promise.race([app.exited(), sleep(20_000)]);
    docker(["rm", "-f", decoyName]);
    check("the decoy this driver created is removed", decoyContainers(), []);
    chrome.stop();
    rmSync(app.home, { recursive: true, force: true });
    say(
      "the real vault at ~/.freebot/provider.env is never read, printed or copied by this driver; its only vault is the placeholder under the temp home named above",
    );
  }

  say("");
  const onDisk = readdirSync(artifactsDir).sort();
  check(
    "one committed PNG per key state",
    onDisk.filter((file) => file.endsWith(".png")),
    SPECS.map((spec) => `${spec.name}.png`),
  );
  for (const file of onDisk) {
    say(`artifact: ${file} (${statSync(join(artifactsDir, file)).size} bytes)`);
  }
  const report = lines.join("\n");
  check("no committed line carries the operator token", report.includes(app.token), false);
  check(
    "no committed line carries a key-shaped literal",
    /FREEBOT_BYOK_KEY=\S{8,}/.test(report),
    false,
  );

  say("");
  say(`checks: ${checks - failures}/${checks} PASS`);
  const result = `RESULT: ${failures === 0 ? "PASS" : "FAIL"} (${checks - failures}/${checks})`;
  writeFileSync(join(artifactsDir, "assert.txt"), [...lines, "", result, ""].join("\n"));
  say(`artifact: packages/verify/artifacts/${feature}/${sha}/assert.txt`);
  console.log(result);
  process.exitCode = failures === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  say(`FAIL driver crashed before the run finished: ${message}`);
  if (artifactsDir !== "") {
    const result = `RESULT: FAIL (${checks - failures}/${checks})`;
    writeFileSync(join(artifactsDir, "assert.txt"), [...lines, "", result, ""].join("\n"));
  }
  process.exitCode = 1;
}
