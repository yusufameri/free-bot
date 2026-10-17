#!/usr/bin/env bun
/**
 * Pi RPC spike driver (Gate 1 evidence).
 *
 * Runs from a repo checkout with dependencies installed: `bun spikes/pi-rpc/drive.ts`.
 *
 * Spawns `pi --mode rpc` with a hermetic HOME, a keyless OpenAI-compatible stub model, and the
 * gate extension, then scripts a session over strict JSONL. Every frame in both directions, every
 * stub-model HTTP request, and every assertion lands in packages/pi-bridge/fixtures/rpc-handshake.jsonl
 * (one JSON object per line). Exits non-zero if any assertion fails.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { type Frame, startStubModel } from "./stub-model";

const here = import.meta.dir;
const repoRoot = resolve(here, "../..");
const piBin = join(repoRoot, "node_modules", ".bin", "pi");
const scratch = join(here, "scratch");
const fixtureDir = join(repoRoot, "packages", "pi-bridge", "fixtures");
const transcriptPath = join(fixtureDir, "rpc-handshake.jsonl");
const helpPath = join(fixtureDir, "help.txt");

const piVersion = new TextDecoder().decode(Bun.spawnSync([piBin, "--version"]).stdout).trim();
const nodeVersion = new TextDecoder().decode(Bun.spawnSync(["node", "--version"]).stdout).trim();

const transcript: string[] = [];
const allFrames: Frame[] = [];
function record(frame: Frame) {
  allFrames.push(frame);
  transcript.push(JSON.stringify(frame));
}

const failures: string[] = [];
const passes: string[] = [];
function check(ok: boolean, label: string) {
  record({ dir: "check", ok, label });
  if (ok) {
    passes.push(label);
  } else {
    failures.push(label);
  }
}

const agentDir = join(scratch, "agent");
const workspace = join(scratch, "workspace");
const home = join(scratch, "home");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(home, { recursive: true });

record({
  dir: "header",
  generator: "spikes/pi-rpc/drive.ts",
  piPackage: "@earendil-works/pi-coding-agent",
  piVersion,
  platform: `${process.platform}-${process.arch}`,
  osRelease: release(),
  node: nodeVersion,
  driveRuntime: `bun ${Bun.version}`,
  startedAt: new Date().toISOString(),
});

const stub = startStubModel(record);
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        stub: {
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
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
    },
    null,
    2,
  ),
);

const spawnArgs = [
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
  join(here, "gate-ext.ts"),
];
record({ dir: "note", note: "spawned pi", command: ["pi", ...spawnArgs], cwd: workspace });

const child = Bun.spawn([piBin, ...spawnArgs], {
  cwd: workspace,
  env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
if (typeof child.stdin === "number") {
  throw new Error("pi stdin is not a pipe");
}
const stdin = child.stdin;

const responseWaiters = new Map<string, (frame: Frame) => void>();
const settledWaiters: Array<() => void> = [];

function waitResponse(id: string, timeoutMs = 15000): Promise<Frame> {
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

function armSettled(timeoutMs = 30000): Promise<void> {
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

function send(frame: Frame) {
  record({ dir: "bridge->pi", ...frame });
  stdin.write(`${JSON.stringify(frame)}\n`);
  stdin.flush();
}

function sendRaw(line: string) {
  record({ dir: "bridge->pi", raw: line });
  stdin.write(`${line}\n`);
  stdin.flush();
}

async function answerUiRequest(frame: Frame): Promise<void> {
  if (frame.method !== "confirm") return;
  const message = String(frame.message ?? "");
  const confirmed = !message.includes("mode=deny");
  send({ type: "extension_ui_response", id: frame.id, confirmed });
}

function onPiFrame(frame: Frame) {
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
  if (frame.type === "extension_ui_request") {
    void answerUiRequest(frame);
  }
}

const decoder = new TextDecoder();
let stdoutBuffer = "";
const stdoutDone = (async () => {
  for await (const chunk of child.stdout) {
    stdoutBuffer += decoder.decode(chunk, { stream: true });
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim().length > 0) {
        try {
          onPiFrame(JSON.parse(line) as Frame);
        } catch (error) {
          record({ dir: "note", note: "unparsable stdout line", line, error: String(error) });
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  }
})();

const stderrLines: string[] = [];
const stderrDone = (async () => {
  for await (const chunk of child.stderr) {
    for (const line of decoder.decode(chunk).split("\n")) {
      if (line.trim().length === 0) continue;
      stderrLines.push(line);
      record({ dir: "pi-stderr", line: line.slice(0, 500) });
    }
  }
})();

const sawFrame = (predicate: (frame: Frame) => boolean) => allFrames.some(predicate);
const framesSince = (mark: number) => allFrames.slice(mark);
const execEnds = (frames: Frame[], toolName: string) =>
  frames.filter(
    (frame) => frame.type === "tool_execution_end" && frame.toolName === toolName,
  ) as Array<Frame & { durationMs?: number; isError?: boolean }>;
const sawToolExec = (kind: "start" | "end", toolName: string) =>
  sawFrame(
    (frame) =>
      frame.dir === "pi->bridge" &&
      frame.type === `tool_execution_${kind}` &&
      frame.toolName === toolName,
  );
const textOf = (frame: Frame | undefined): string =>
  JSON.stringify(frame?.result ?? frame?.error ?? "");
const stubRequests = () =>
  allFrames.filter((frame) => frame.dir === "stub" && frame.kind === "request");
const stubSaw = (needle: string, frames: Frame[] = allFrames) =>
  frames
    .filter((frame) => frame.dir === "stub" && frame.kind === "request")
    .some(
      (frame) =>
        Array.isArray(frame.toolResults) &&
        (frame.toolResults as string[]).some((text) => text.includes(needle)),
    );

async function promptTurn(label: string, message: string, timeoutMs = 30000) {
  const id = `turn-${label}`;
  const settled = armSettled(timeoutMs);
  send({ id, type: "prompt", message });
  const response = await waitResponse(id, timeoutMs);
  check(response.success === true, `${label}: prompt accepted`);
  await settled;
  await Bun.sleep(50);
}

async function turn(label: string, message: string): Promise<Frame[]> {
  const mark = allFrames.length;
  await promptTurn(label, message);
  return framesSince(mark);
}

async function main() {
  const statePromise = waitResponse("state-1");
  send({ id: "state-1", type: "get_state" });
  const state = await statePromise;
  check(state.success === true, "get_state: success");
  const stateData = state.data as Frame | undefined;
  check(stateData?.isStreaming === false, "get_state: not streaming");
  const model = stateData?.model as Frame | undefined;
  check(model?.id === "stub-1", "get_state: stub model selected from models.json");

  sendRaw('{"id":"malformed-1","type":');
  await Bun.sleep(300);
  check(
    sawFrame(
      (frame) =>
        frame.dir === "pi->bridge" &&
        frame.type === "response" &&
        frame.command === "parse" &&
        frame.success === false,
    ),
    "malformed JSON: parse error response",
  );

  const commandsPromise = waitResponse("commands-1");
  send({ id: "commands-1", type: "get_commands" });
  const commands = await commandsPromise;
  const commandList = ((commands.data as Frame | undefined)?.commands ?? []) as Frame[];
  check(
    commandList.some((entry) => entry.name === "gate-info" && entry.source === "extension"),
    "get_commands: extension command listed",
  );

  const modelsPromise = waitResponse("models-1");
  send({ id: "models-1", type: "get_available_models" });
  const models = await modelsPromise;
  const modelList = ((models.data as Frame | undefined)?.models ?? []) as Frame[];
  check(
    modelList.some((entry) => entry.id === "stub-1" && entry.provider === "stub"),
    "get_available_models: stub provider from models.json",
  );

  const setModelPromise = waitResponse("badmodel-1");
  send({ id: "badmodel-1", type: "set_model", provider: "not-a-provider", modelId: "nope" });
  const setModel = await setModelPromise;
  check(
    setModel.success === false && typeof setModel.error === "string",
    "set_model: unknown model returns success:false with error",
  );

  const bashPromise = waitResponse("bash-1");
  send({ id: "bash-1", type: "bash", command: "echo native-bash-no-model" });
  const bash = await bashPromise;
  const bashData = bash.data as Frame | undefined;
  check(
    bash.success === true && String(bashData?.output ?? "").includes("native-bash-no-model"),
    "RPC bash command: client-issued shell runs without a model",
  );
  check(
    sawFrame((frame) => frame.dir === "pi->bridge" && frame.type === "bash_execution_update"),
    "RPC bash command: bash_execution_update streamed",
  );

  const infoPromise = waitResponse("cmd-info-1");
  send({ id: "cmd-info-1", type: "prompt", message: "/gate-info" });
  const info = await infoPromise;
  const infoData = info.data as Frame | undefined;
  check(
    info.success === true && infoData?.disposition === "handled",
    "extension command: /gate-info handled with no model run",
  );
  await Bun.sleep(250);
  const notify = allFrames.find(
    (frame) =>
      frame.dir === "pi->bridge" &&
      frame.type === "extension_ui_request" &&
      frame.method === "notify" &&
      String(frame.message).includes("activeTools"),
  );
  check(notify !== undefined, "extension UI: gate-info notify over RPC");
  let activeTools: string[] = [];
  if (notify) {
    const payload = JSON.parse(String(notify.message)) as {
      mode?: string;
      hasUI?: boolean;
      activeTools?: string[];
    };
    activeTools = payload.activeTools ?? [];
    record({ dir: "note", note: "gate-info payload", payload });
    check(payload.mode === "rpc" && payload.hasUI === true, "gate-info: rpc mode with UI");
    check(
      activeTools.includes("gated_echo") && !activeTools.includes("bash"),
      "--no-builtin-tools: only extension tools active",
    );
  }
  check(!sawFrame((frame) => frame.type === "agent_settled"), "extension command: no model run");

  const blockedFrames = await turn("blocked", "spike: call gated_blocked");
  const blockedEnd = execEnds(blockedFrames, "gated_blocked")[0];
  check(
    blockedEnd !== undefined &&
      blockedEnd.isError === true &&
      blockedEnd.durationMs === undefined &&
      textOf(blockedEnd).includes("blocked by gate-spike: always deny") &&
      !textOf(blockedEnd).includes("gate failed"),
    "blocked turn: gate stopped execution before execute() ran",
  );
  check(
    stubSaw("blocked by gate-spike: always deny", blockedFrames),
    "blocked turn: model saw the gate reason",
  );

  const echoFrames = await turn("echo", "spike: call gated_echo");
  const echoEnd = execEnds(echoFrames, "gated_echo")[0];
  check(
    sawToolExec("start", "gated_echo") &&
      echoEnd !== undefined &&
      typeof echoEnd.durationMs === "number",
    "echo turn: allowed call executed",
  );
  check(
    textOf(echoEnd).includes("gated_echo ran: hello-from-stub"),
    "echo turn: tool result content on the wire",
  );
  check(
    stubSaw("gated_echo ran: hello-from-stub", echoFrames),
    "echo turn: model saw the tool result",
  );

  const denyFrames = await turn("confirm-deny", "spike: call gated_confirm_deny");
  check(
    sawFrame(
      (frame) =>
        frame.dir === "pi->bridge" &&
        frame.type === "extension_ui_request" &&
        frame.method === "confirm" &&
        String(frame.message).includes("mode=deny"),
    ),
    "confirm-deny: approval request reached the client",
  );
  check(
    sawFrame(
      (frame) =>
        frame.dir === "bridge->pi" &&
        frame.type === "extension_ui_response" &&
        frame.confirmed === false,
    ),
    "confirm-deny: client denied over the wire",
  );
  const denyEnd = execEnds(denyFrames, "gated_confirm")[0];
  check(
    denyEnd !== undefined &&
      denyEnd.isError === true &&
      denyEnd.durationMs === undefined &&
      textOf(denyEnd).includes("denied by operator"),
    "confirm-deny: denied call did not execute",
  );
  check(stubSaw("denied by operator", denyFrames), "confirm-deny: model saw the denial");

  const allowFrames = await turn("confirm-allow", "spike: call gated_confirm_allow");
  const allowEnd = execEnds(allowFrames, "gated_confirm").find((frame) =>
    textOf(frame).includes("gated_confirm executed (mode=allow)"),
  );
  check(
    allowEnd !== undefined && typeof allowEnd.durationMs === "number",
    "confirm-allow: allowed call executed",
  );
  check(
    stubSaw("gated_confirm executed (mode=allow)", allowFrames),
    "confirm-allow: model saw the result",
  );

  const runnerFrames = await turn("runner", "spike: call gate_demo_runner");
  const runnerEnd = execEnds(runnerFrames, "gate_demo_runner")[0];
  check(
    runnerEnd !== undefined && typeof runnerEnd.durationMs === "number",
    "runner: runner tool executed",
  );
  check(
    runnerFrames.some(
      (frame) =>
        frame.type === "tool_execution_end" &&
        frame.toolName === "gated_echo" &&
        typeof frame.parentToolCallId === "string",
    ),
    "runner: nested call carries parentToolCallId",
  );
  check(
    stubSaw("nested result = gated_echo ran: nested-via-runner", runnerFrames),
    "runner: nested result reached the model",
  );

  const bashFrames = await turn("native-bash", "spike: use native bash");
  check(
    execEnds(bashFrames, "bash").every((frame) => frame.durationMs === undefined),
    "native-bash: no bash tool execution",
  );
  check(stubSaw("Tool bash not found", bashFrames), "native-bash: model saw Tool bash not found");

  check(stubRequests().length === 12, "stub model: 12 requests, all keyless");
  check(
    stubRequests().every((frame) => frame.model === "stub-1"),
    "stub model: every request targeted stub-1",
  );

  stdin.end();
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(10000).then(() => {
      child.kill();
      return -1;
    }),
  ]);
  await stdoutDone;
  await stderrDone;
  record({ dir: "note", note: "pi exited", exitCode, stderrLines: stderrLines.length });
  check(exitCode === 0, "shutdown: stdin close exits pi cleanly");

  const help = new TextDecoder().decode(Bun.spawnSync([piBin, "--help"]).stdout);
  const rpcHelp = new TextDecoder().decode(
    Bun.spawnSync([piBin, "--mode", "rpc", "--help"]).stdout,
  );
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    helpPath,
    [
      `# pi --version`,
      piVersion,
      "",
      "# pi --help",
      help.trimEnd(),
      "",
      "# pi --mode rpc --help (same option surface)",
      rpcHelp.trimEnd(),
      "",
    ].join("\n"),
  );
  record({ dir: "note", note: "wrote help fixture", path: helpPath });

  writeFileSync(transcriptPath, `${transcript.join("\n")}\n`);
  stub.stop();
}

await main();

const summary = [
  "",
  `spike transcript: ${transcriptPath}`,
  `checks passed: ${passes.length}`,
  `checks failed: ${failures.length}`,
  ...failures.map((label) => `FAIL: ${label}`),
  "",
].join("\n");
console.log(summary);
process.exit(failures.length === 0 ? 0 : 1);
