#!/usr/bin/env node
/**
 * In-VM replay driver for the pinned sandbox image.
 *
 * Spawns `pi --mode rpc` against the keyless local stub, drives one scripted prompt turn, and
 * writes every frame Pi emits on stdout plus every stub-model request, in arrival order, to a
 * JSONL file whose first line is the run header. Exits non-zero on any failed assertion.
 *
 * Usage: node /image/replay.mjs /out/replay1.jsonl
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { startStubModel } from "./stub-model.mjs";

const outPath = process.argv[2] ?? "/out/replay.jsonl";
const extPath = process.env.REPLAY_EXT ?? "/image/replay-ext.ts";
const stubPort = Number(process.env.STUB_PORT ?? "39412");
const scratch = "/tmp/replay";
const home = join(scratch, "home");
const agentDir = join(scratch, "agent");
const workspace = join(scratch, "workspace");

const failures = [];
const frames = [];
function check(ok, label) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
}
function record(frame) {
  frames.push(frame);
}

const watchdog = setTimeout(() => {
  console.error("replay watchdog: no progress after 120s");
  process.exit(4);
}, 120_000);

const piArgs = [
  "--mode",
  "rpc",
  "--no-session",
  "--offline",
  "--no-approve",
  "--no-builtin-tools",
  "--provider",
  "stub",
  "--model",
  "stub-1",
  "-e",
  extPath,
];

function modelsJson(port) {
  return {
    providers: {
      stub: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "keyless-stub-literal",
        models: [
          {
            id: "stub-1",
            name: "Keyless stub",
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
}

async function main() {
  rmSync(scratch, { recursive: true, force: true });
  for (const dir of [home, agentDir, workspace]) mkdirSync(dir, { recursive: true });

  const stub = await startStubModel(stubPort, record);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(stub.port), null, 2));

  const piVersion = spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout.trim();
  const imageDigest = process.env.SANDBOX_IMAGE_DIGEST ?? "";
  check(piVersion === "1.3.0", `pi version is 1.3.0 (got ${piVersion})`);
  check(imageDigest.startsWith("sha256:"), `image digest passed in (${imageDigest})`);

  const child = spawn("pi", piArgs, {
    cwd: workspace,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const responseWaiters = new Map();
  const settledWaiters = [];

  function waitResponse(id, timeoutMs = 20000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        responseWaiters.delete(id);
        rejectPromise(new Error(`timeout: no response for ${id}`));
      }, timeoutMs);
      responseWaiters.set(id, (frame) => {
        clearTimeout(timer);
        resolvePromise(frame);
      });
    });
  }

  function armSettled(timeoutMs = 30000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("timeout: agent_settled never arrived")),
        timeoutMs,
      );
      settledWaiters.push(() => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  function send(frame) {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function onPiFrame(frame) {
    record({ dir: "pi->bridge", ...frame });
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (id !== undefined && frame.type === "response") {
      const waiter = responseWaiters.get(id);
      if (waiter) {
        responseWaiters.delete(id);
        waiter(frame);
      }
    }
    if (frame.type === "agent_settled") {
      for (const waiter of settledWaiters.splice(0)) waiter();
    }
  }

  const stderrLines = [];
  let stdoutBuffer = "";
  const stdoutDone = (async () => {
    const decoder = new TextDecoder();
    for await (const piece of child.stdout) {
      stdoutBuffer += decoder.decode(piece, { stream: true });
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.trim().length > 0) {
          try {
            onPiFrame(JSON.parse(line));
          } catch (error) {
            check(false, `unparsable pi stdout line: ${line.slice(0, 200)} (${error})`);
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    }
  })();
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const piece of child.stderr) {
      for (const line of decoder.decode(piece).split("\n")) {
        if (line.trim().length > 0) stderrLines.push(line);
      }
    }
  })();

  const statePromise = waitResponse("state-1");
  send({ id: "state-1", type: "get_state" });
  const state = await statePromise;
  check(state.success === true, "get_state: success");
  check(state.data?.model?.id === "stub-1", "get_state: stub-1 selected from models.json");

  const settled = armSettled();
  const promptPromise = waitResponse("turn-1");
  send({ id: "turn-1", type: "prompt", message: "replay: call replay_echo" });
  const prompt = await promptPromise;
  check(prompt.success === true, "prompt: accepted");
  check(prompt.data?.disposition === "started", "prompt: disposition started");
  await settled;
  check(true, "run: agent_settled arrived");

  const sawEchoEnd = frames.some(
    (frame) =>
      frame.dir === "pi->bridge" &&
      frame.type === "tool_execution_end" &&
      frame.toolName === "replay_echo" &&
      JSON.stringify(frame.result ?? "").includes("replay_echo ran: hello-from-stub"),
  );
  check(sawEchoEnd, "tool: replay_echo executed with the stub argument");
  check(
    frames.some(
      (frame) =>
        frame.dir === "pi->bridge" &&
        frame.type === "tool_execution_start" &&
        frame.toolName === "replay_echo",
    ),
    "tool: replay_echo start frame emitted",
  );
  check(
    frames.some(
      (frame) =>
        frame.dir === "stub" &&
        frame.kind === "request" &&
        frame.toolResults?.some((text) => text.includes("replay_echo ran: hello-from-stub")),
    ),
    "tool: result reached the model",
  );

  child.stdin.end();
  const exitCode = await Promise.race([
    new Promise((resolvePromise) => child.on("exit", (code) => resolvePromise(code))),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(-1), 15000)),
  ]);
  await stdoutDone;
  await stderrDone;
  if (exitCode === -1) child.kill();
  check(exitCode === 0, `shutdown: stdin close exits pi cleanly (exit ${exitCode})`);
  check(stderrLines.length === 0, `pi stderr is empty (${stderrLines.length} lines)`);

  await stub.stop();

  const header = {
    dir: "header",
    driver: "packages/sandbox/image/replay.mjs",
    pi_version: piVersion,
    image_digest: imageDigest,
    node: process.version,
    platform: `${platform()}-${arch()}`,
    os_release: release(),
    pi_command: ["pi", ...piArgs],
  };
  writeFileSync(outPath, `${[header, ...frames].map((f) => JSON.stringify(f)).join("\n")}\n`);

  console.log(
    JSON.stringify({
      out: outPath,
      pi_version: piVersion,
      image_digest: imageDigest,
      events: frames.length,
      checks_failed: failures.length,
      failures,
    }),
  );
  clearTimeout(watchdog);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`replay driver error: ${error}`);
  process.exit(2);
});
