#!/usr/bin/env bun
/**
 * pi-bridge smoke: one real Pi process, one tool call through the Gate 1 extension, one real
 * provider. This is the keyed half of the bridge's evidence (Gate 3, plan 9.8); the replay
 * transport covers the keyless half in `bun test`.
 *
 * Key resolution follows gate G1: FREEBOT_BYOK_KEY in the environment, or a FREEBOT_BYOK_KEY=...
 * line in ~/.freebot/provider.env. This process never reads the key value: models.json either
 * interpolates the environment variable or runs `!command` against the vault file. Keyless
 * machines print `parked: G1 BYOK key absent` and exit 0.
 *
 * Optional environment: FREEBOT_BYOK_BASE_URL (default https://api.openai.com/v1) and
 * FREEBOT_BYOK_MODEL (default gpt-4o-mini).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SMOKE_ECHO_TOOL } from "../extension/smoke-tool.ts";
import { allowTools, type ToolExecutionEndEvent } from "../src/index.ts";
import { PiSession } from "../src/session.ts";
import { spawnPiTransport } from "../src/transport.ts";

const vaultPath = join(homedir(), ".freebot", "provider.env");
const envKeyPresent = (process.env.FREEBOT_BYOK_KEY ?? "").length > 0;
const vaultKeyPresent =
  !envKeyPresent &&
  existsSync(vaultPath) &&
  Bun.spawnSync(["grep", "-q", "^FREEBOT_BYOK_KEY=", vaultPath]).exitCode === 0;

if (!envKeyPresent && !vaultKeyPresent) {
  console.log("parked: G1 BYOK key absent");
  process.exit(0);
}

const provider = "byok";
const modelId = process.env.FREEBOT_BYOK_MODEL ?? "gpt-4o-mini";
const baseUrl = process.env.FREEBOT_BYOK_BASE_URL ?? "https://api.openai.com/v1";
const apiKey = envKeyPresent
  ? "$FREEBOT_BYOK_KEY"
  : `!grep -m1 ^FREEBOT_BYOK_KEY= "${vaultPath}" | cut -d= -f2-`;

const piBin = resolve(import.meta.dir, "../../../node_modules/.bin/pi");
const scratch = mkdtempSync(join(tmpdir(), "freebot-pi-smoke-"));
const agentDir = join(scratch, "agent");
const home = join(scratch, "home");
const workspace = join(scratch, "workspace");
mkdirSync(agentDir, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });

writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        [provider]: {
          baseUrl,
          api: "openai-completions",
          apiKey,
          models: [
            {
              id: modelId,
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
  modelId,
  "-e",
  resolve(import.meta.dir, "../extension/tool-gate.ts"),
  "-e",
  resolve(import.meta.dir, "../extension/smoke-echo.ts"),
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
  await session.request({
    type: "prompt",
    message:
      `Call the ${SMOKE_ECHO_TOOL} tool exactly once with text "live-smoke". ` +
      "After the tool result arrives, reply with the exact text it returned.",
  });
  await settled;

  const ends = session.events.filter(
    (frame): frame is ToolExecutionEndEvent =>
      frame.type === "tool_execution_end" && frame.toolName === SMOKE_ECHO_TOOL,
  );
  const allows = session.toolGates.filter((entry) => entry.outcome === "allow");
  const text = ends[0]?.result.content[0]?.text ?? "";
  const ok =
    ends.length >= 1 && ends.every((end) => end.isError === false) && allows.length === ends.length;

  if (ok) {
    console.log(
      `PASS pi-bridge smoke: 1 gated tool call, model ${modelId} via ${provider}, result "${text}"`,
    );
    exitCode = 0;
  } else {
    console.log(
      `FAIL pi-bridge smoke: tool calls=${ends.length} isError=${ends.map((end) => end.isError).join(",")} gate=${JSON.stringify(session.toolGates)}`,
    );
    for (const line of transport.stderrLines.slice(-10)) console.log(`pi-stderr: ${line}`);
  }
} catch (error) {
  console.log(`FAIL pi-bridge smoke: ${error instanceof Error ? error.message : String(error)}`);
  for (const line of transport.stderrLines.slice(-10)) console.log(`pi-stderr: ${line}`);
} finally {
  session.close();
  await Promise.race([transport.exited, Bun.sleep(5000)]);
  rmSync(scratch, { recursive: true, force: true });
}

process.exit(exitCode);
