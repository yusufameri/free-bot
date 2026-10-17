#!/usr/bin/env bun
/**
 * The save-time smoke test for one connection: `bun packages/providers/scripts/smoke.ts <baseUrl>
 * <model>`.
 *
 * Live, it drives ONE real Pi tool-call turn through the bridge with the Gate 1 intercept, then
 * derives the capability flags from what it observed. Keyless, it replays the recorded tool-call
 * turn out of the committed pi-bridge transcript and derives the same flags, so the command runs
 * green on a machine with no key (gate G1 parks the live half).
 *
 * This process never reads the key value unless the key is in the environment, and it never prints
 * one: the report carries `keyPresent` only. Key resolution follows G1, the same way the pi-bridge
 * smoke resolves it: FREEBOT_BYOK_KEY in the environment, or a FREEBOT_BYOK_KEY= line in
 * ~/.freebot/provider.env, which stays in the vault file and is interpolated by Pi's own
 * `!command` support.
 *
 * Exit 0 when the probe derived flags for a connection that can drive Pi (toolCalling strong or
 * weak), 1 when it cannot, 2 on a usage error.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SMOKE_ECHO_TOOL } from "../../pi-bridge/extension/smoke-tool.ts";
import { allowTools, PiSession, spawnPiTransport } from "../../pi-bridge/src/index.ts";
import { OpenAiCompatibleClient, type ToolSpec } from "../src/client.ts";
import { ProviderRefusalError } from "../src/errors.ts";
import { runStructuredToolTurn } from "../src/fallback.ts";
import { formatFlags, observeTurn, type StructuredObservation } from "../src/flags.ts";
import { probeReplayFixture, probeRun, structuredFromTurn } from "../src/probe.ts";

const USAGE =
  "usage: bun packages/providers/scripts/smoke.ts <baseUrl> <model> [--replay] [--fixture <path>]";
const FIXTURE = resolve(import.meta.dir, "../../pi-bridge/fixtures/rpc-handshake.jsonl");
const VAULT_PATH = join(homedir(), ".freebot", "provider.env");

/** The echo tool's schema, mirroring pi-bridge's extension for the direct structured-output step. */
const ECHO_SPEC: ToolSpec = {
  name: SMOKE_ECHO_TOOL,
  description: "Echo text back.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

const PROMISE =
  `Call the ${SMOKE_ECHO_TOOL} tool exactly once with text "save-time-smoke". ` +
  "After the tool result arrives, reply with the exact text it returned.";

function envKeyPresent(): boolean {
  return (process.env.FREEBOT_BYOK_KEY ?? "").length > 0;
}

function vaultKeyPresent(): boolean {
  return (
    !envKeyPresent() &&
    existsSync(VAULT_PATH) &&
    Bun.spawnSync(["grep", "-q", "^FREEBOT_BYOK_KEY=", VAULT_PATH]).exitCode === 0
  );
}

function report(header: string[], lines: string[]): void {
  for (const line of header) console.log(line);
  console.log("capability flags (from the observed turn, never from the model name):");
  for (const line of lines) console.log(`  ${line}`);
}

const argv = process.argv.slice(2);
const flags = {
  replay: argv.includes("--replay"),
  fixture: argv.includes("--fixture") ? argv[argv.indexOf("--fixture") + 1] : undefined,
};
const positional = argv.filter(
  (arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--fixture",
);
const [baseUrl, model] = positional;
const keyPresent = envKeyPresent() || vaultKeyPresent();
const mode = flags.replay || !keyPresent ? "replay" : "live";

if (mode === "live" && (baseUrl === undefined || model === undefined)) {
  console.error(`live mode needs a base URL and a model\n${USAGE}`);
  process.exit(2);
}

if (mode === "replay") {
  const fixture = flags.fixture ?? FIXTURE;
  const run = await probeReplayFixture(fixture);
  report(
    [
      `providers smoke: mode=replay${keyPresent ? " (--replay asked for it)" : " (G1 BYOK key absent)"}`,
      `fixture: ${fixture.replace(`${process.cwd()}/`, "")}`,
      run.recorded === null
        ? `connection: keyPresent=${keyPresent}`
        : `connection (from the recording): provider=${run.recorded.provider} model=${run.recorded.modelId} baseUrl=${run.recorded.baseUrl} keyPresent=${keyPresent}`,
    ],
    [...formatFlags(run.flags), ...run.flags.notes.map((note) => `note: ${note}`)],
  );
  console.log(`replayed turn: tool=${run.toolName} requests=${run.requestsWritten} settled=true`);
  console.log(`commands written: ${run.sent.join(" | ")}`);
  if (run.flags.toolCalling === "none") {
    console.log("FAIL providers smoke (replay): the recorded turn drove no tool call");
    process.exit(1);
  }
  console.log(
    "PASS providers smoke (replay): one recorded Pi tool-call turn, no live provider called",
  );
  process.exit(0);
}

// --------------------------------------------------------------------------
// Live: one real Pi tool-call turn through the bridge
// --------------------------------------------------------------------------

const provider = "byok";
const liveBaseUrl = baseUrl as string;
const liveModel = model as string;
const apiKey = envKeyPresent()
  ? "$FREEBOT_BYOK_KEY"
  : `!grep -m1 ^FREEBOT_BYOK_KEY= "${VAULT_PATH}" | cut -d= -f2-`;

const scratch = mkdtempSync(join(tmpdir(), "freebot-providers-smoke-"));
const agentDir = join(scratch, "agent");
const home = join(scratch, "home");
const workspace = join(scratch, "workspace");
for (const dir of [agentDir, home, workspace]) mkdirSync(dir, { recursive: true });

writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        [provider]: {
          baseUrl: liveBaseUrl,
          api: "openai-completions",
          apiKey,
          models: [
            {
              id: liveModel,
              name: "BYOK smoke model",
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    null,
    2,
  ),
);

const piBin = resolve(import.meta.dir, "../../../node_modules/.bin/pi");
const command = [
  piBin,
  "--mode",
  "rpc",
  "--no-session",
  "--no-approve",
  "--no-builtin-tools",
  "--provider",
  provider,
  "--model",
  liveModel,
  "-e",
  resolve(import.meta.dir, "../../pi-bridge/extension/tool-gate.ts"),
  "-e",
  resolve(import.meta.dir, "../../pi-bridge/extension/smoke-echo.ts"),
];

const transport = spawnPiTransport({
  command,
  cwd: workspace,
  env: { HOME: home, PI_CODING_AGENT_DIR: agentDir },
});
const session = new PiSession(transport, {
  gate: allowTools([SMOKE_ECHO_TOOL]),
  requestTimeoutMs: 60_000,
});

let exitCode = 1;
try {
  const settled = session.waitForSettled(180_000);
  await session.request({ type: "prompt", message: PROMISE });
  await settled;

  const models = await session.request({ type: "get_available_models" });
  const listed =
    typeof models.data === "object" &&
    models.data !== null &&
    Array.isArray((models.data as { models?: unknown[] }).models)
      ? (models.data as { models: Array<Record<string, unknown>> }).models
      : [];
  const entry = listed.find((candidate) => candidate.id === liveModel);
  const contextWindow =
    typeof entry?.contextWindow === "number" ? (entry.contextWindow as number) : null;

  const observation = observeTurn(session.events);
  let structured = structuredFromTurn(observation);
  let structuredNote = "observed in the live turn";
  if (structured === null) {
    const keyValue = envKeyPresent() ? (process.env.FREEBOT_BYOK_KEY as string) : null;
    if (keyValue === null) {
      structuredNote =
        "not exercised: the key lives in the vault and this probe does not read key values";
    } else {
      const client = new OpenAiCompatibleClient(
        { baseUrl: liveBaseUrl, apiKey: keyValue },
        { timeoutMs: 30_000 },
      );
      const outcome = await runStructuredToolTurn(client, {
        model: liveModel,
        task: `Call ${SMOKE_ECHO_TOOL} with text "save-time-smoke".`,
        tools: [ECHO_SPEC],
      });
      structured = {
        parsableJson: outcome.reply.kind !== "invalid",
        toolCall: outcome.reply.kind === "tool_call",
      } satisfies StructuredObservation;
      structuredNote =
        outcome.failure === null
          ? "one direct response_format:json_object request parsed"
          : `one direct request failed: ${outcome.failure.reason}`;
    }
  }

  const run = probeRun({
    observation,
    contextWindow,
    structured,
    toolName: SMOKE_ECHO_TOOL,
    recorded: null,
    requestsWritten: 2,
    sent: [],
  });

  report(
    [
      "providers smoke: mode=live",
      `connection: baseUrl=${liveBaseUrl} provider=${provider} model=${liveModel} keyPresent=true`,
    ],
    [
      ...formatFlags(run.flags),
      ...run.flags.notes.map((note) => `note: ${note}`),
      `note: structured output path ${structuredNote}`,
    ],
  );

  if (run.flags.toolCalling === "none") {
    console.log("FAIL providers smoke: this model cannot drive Pi: no tool call observed");
    for (const line of transport.stderrLines.slice(-10)) console.log(`pi-stderr: ${line}`);
  } else {
    console.log(`PASS providers smoke: mode=live toolCalling=${run.flags.toolCalling}`);
    exitCode = 0;
  }
} catch (error) {
  const detail =
    error instanceof ProviderRefusalError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  console.log(`FAIL providers smoke: ${detail}`);
  for (const line of transport.stderrLines.slice(-10)) console.log(`pi-stderr: ${line}`);
} finally {
  session.close();
  await Promise.race([transport.exited, Bun.sleep(5000)]);
  rmSync(scratch, { recursive: true, force: true });
}

process.exit(exitCode);
