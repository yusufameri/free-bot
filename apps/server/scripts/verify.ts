#!/usr/bin/env bun
/**
 * The evidence run for the localhost control plane, against a really launched server.
 *
 * `apps/server/src/index.ts` starts as its own process on ephemeral ports, exactly as an operator
 * starts it. Everything this script claims is read out of that process: the printed token, the
 * refusal matrix read from real HTTP responses, a real oRPC round trip, and an event that arrived
 * over a real WebSocket. It refuses to write an artifact containing the token.
 *
 *   bun apps/server/scripts/verify.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type apiContract, type EventMessage, safeParseMessage } from "@freebot/protocol";
import { createORPCClient } from "@orpc/client";
import { RPCLink as FetchLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const feature = "server-auth";

type ApiClient = ContractRouterClient<typeof apiContract>;

const lines: string[] = [];
const failures: string[] = [];

function check(ok: boolean, line: string): void {
  lines.push(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures.push(line);
}

function shell(command: string[]): { ok: boolean; output: string } {
  const proc = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return { ok: proc.exitCode === 0, output };
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return proc.stdout.toString().trim();
}

/** One matrix arm: curl the launched server and read status plus body out of the reply. */
function curl(
  port: number,
  path: string,
  headers: string[],
  method = "POST",
): { status: string; body: string } {
  const args = ["curl", "-sS", "--max-time", "5", "-X", method, "-w", "\n%{http_code}"];
  for (const header of headers) args.push("-H", header);
  if (method === "POST") {
    args.push("-H", "content-type: application/json", "--data", '{"json":{"prompt":"verify"}}');
  }
  args.push(`http://127.0.0.1:${port}${path}`);
  const proc = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const raw = proc.stdout.toString().trim();
  const cut = raw.lastIndexOf("\n");
  return { status: raw.slice(cut + 1).trim(), body: raw.slice(0, cut).trim() };
}

function codeOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    return parsed.error?.code ?? "(no code)";
  } catch {
    return `(unparsable: ${body.slice(0, 60)})`;
  }
}

async function waitFor(read: () => string, match: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = match.exec(read());
    if (found?.[1] !== undefined) return found[1];
    await Bun.sleep(20);
  }
  throw new Error(`no line matching ${match} within ${timeoutMs}ms; saw: ${read().slice(-400)}`);
}

async function until(ready: () => boolean, what: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await Bun.sleep(20);
  }
  check(false, `timed out after ${timeoutMs}ms waiting for ${what}`);
  return false;
}

const head = git(["rev-parse", "HEAD"]);
const shortSha = git(["rev-parse", "--short", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

const typecheck = shell(["bun", "run", "typecheck"]);
check(typecheck.ok, "bun run typecheck");
const lint = shell(["bun", "run", "lint"]);
check(lint.ok, "bun run lint");
const tests = shell(["bun", "test", "apps/server"]);
const testTail = tests.output.split("\n").at(-1) ?? "";
check(tests.ok, `bun test apps/server -> ${testTail}`);

// ---------------------------------------------------------------------------
// The launched server
// ---------------------------------------------------------------------------

const server = Bun.spawn(["bun", "apps/server/src/index.ts"], {
  cwd: root,
  env: { ...process.env, PORT: "0", API_PORT: "0" },
  stdout: "pipe",
  stderr: "pipe",
});

let serverOutput = "";
let launchToken: string | undefined;

try {
  for (const stream of [server.stdout, server.stderr]) {
    void (async () => {
      for await (const chunk of stream) serverOutput += new TextDecoder().decode(chunk);
    })();
  }

  const apiPort = Number(
    await waitFor(() => serverOutput, /control plane on http:\/\/127\.0\.0\.1:(\d+)/, 10_000),
  );
  const token = await waitFor(() => serverOutput, /operator token: (\S+)/, 10_000);
  launchToken = token;

  check(
    /^[A-Za-z0-9_-]{43}$/.test(token),
    `token printed once at boot: ${token.length} url-safe chars`,
  );
  const tunnelPort = Number(
    await waitFor(() => serverOutput, /listening on http:\/\/127\.0\.0\.1:(\d+)/, 10_000),
  );
  check(
    tunnelPort > 0,
    `the tunnel leg still announces its port for bun run verify: ${serverOutput.split("\n")[0]}`,
  );

  const lsof = shell(["lsof", "-nP", `-iTCP:${apiPort}`, "-sTCP:LISTEN"]);
  const listen = lsof.output.split("\n").find((line) => line.includes(`127.0.0.1:${apiPort}`));
  check(
    listen?.includes("(LISTEN)") === true,
    `bound loopback only: ${listen?.replace(/\s+/g, " ").trim() ?? lsof.output.split("\n")[0]}`,
  );

  const lan = Object.values(networkInterfaces())
    .flat()
    .find((iface) => iface?.family === "IPv4" && iface.internal === false);
  if (lan === undefined) {
    lines.push("SKIP lan probe: no non-loopback IPv4 on this host");
  } else {
    const probe = await fetch(`http://${lan.address}:${apiPort}/healthz`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      () => "answered",
      (error: unknown) => (error instanceof Error ? error.message : "refused"),
    );
    check(
      probe !== "answered",
      `a LAN address cannot reach it: http://${lan.address}:${apiPort}/healthz -> ${probe.split("\n")[0]}`,
    );
  }

  // -------------------------------------------------------------------------
  // The 401/403/200 matrix, from real responses
  // -------------------------------------------------------------------------

  const origin = `http://127.0.0.1:${apiPort}`;
  const arm = (
    label: string,
    headers: string[],
    expected: { status: string; code?: string },
  ): { status: string; body: string } => {
    const response = curl(apiPort, "/rpc/start_run", headers);
    const code = response.status === "200" ? undefined : codeOf(response.body);
    const ok = response.status === expected.status && code === expected.code;
    check(
      ok,
      `${label} -> ${response.status}${code === undefined ? "" : ` ${code}`}${ok ? "" : ` (expected ${expected.status} ${expected.code ?? ""})`}`,
    );
    return response;
  };

  arm("POST /rpc/start_run with no token", [`origin: ${origin}`], {
    status: "401",
    code: "token_missing",
  });
  arm(
    "POST /rpc/start_run with a wrong token",
    [`origin: ${origin}`, "authorization: Bearer 0000"],
    {
      status: "401",
      code: "token_mismatch",
    },
  );
  arm(
    "POST /rpc/start_run from a foreign Origin",
    [`origin: http://evil.example`, `authorization: Bearer ${token}`],
    { status: "403", code: "origin_not_allowed" },
  );
  arm(
    "POST /rpc/start_run with a rebound Host",
    [`origin: ${origin}`, `authorization: Bearer ${token}`, "host: evil.example"],
    { status: "403", code: "host_not_allowed" },
  );
  const allowed = arm(
    "POST /rpc/start_run with the printed token",
    [`origin: ${origin}`, `authorization: Bearer ${token}`],
    { status: "200" },
  );
  const matrixRunId = /"runId":"(run_[0-9a-f-]{36})"/.exec(allowed.body)?.[1];
  check(matrixRunId !== undefined, `the allowed arm minted a run: ${allowed.body}`);

  const health = curl(apiPort, "/healthz", [], "GET");
  check(
    health.status === "200" && health.body.includes('"service":"freebot-server"'),
    `GET /healthz stays a liveness probe -> ${health.status} ${health.body}`,
  );

  // -------------------------------------------------------------------------
  // The tunnel leg's HTTP reads, host-checked with the agent's allowance
  // -------------------------------------------------------------------------

  const readArm = (
    label: string,
    path: string,
    host: string,
    expected: { status: string; code?: string },
  ): { status: string; body: string } => {
    const response = curl(tunnelPort, path, [`host: ${host}`], "GET");
    const code = response.status === "200" ? undefined : codeOf(response.body);
    const ok = response.status === expected.status && code === expected.code;
    check(
      ok,
      `${label} -> ${response.status}${code === undefined ? "" : ` ${code}`}${ok ? "" : ` (expected ${expected.status} ${expected.code ?? ""})`}`,
    );
    return response;
  };

  readArm("GET /events on the tunnel leg with a rebound Host", "/events", "evil.example", {
    status: "403",
    code: "host_not_allowed",
  });
  readArm("GET /audit on the tunnel leg with a rebound Host", "/audit", "evil.example", {
    status: "403",
    code: "host_not_allowed",
  });
  const agentRead = readArm(
    "GET /events on the tunnel leg as the in-sandbox agent",
    "/events",
    `host.docker.internal:${tunnelPort}`,
    { status: "200" },
  );
  check(
    agentRead.body === '{"last_seq":0,"count":0,"reply_is_exact":true,"frames":[]}',
    `the agent's read returns the real log body: ${agentRead.body}`,
  );
  const agentAudit = readArm(
    "GET /audit on the tunnel leg as the in-sandbox agent",
    "/audit",
    `host.docker.internal:${tunnelPort}`,
    { status: "200" },
  );
  check(
    agentAudit.body ===
      '{"firstSeq":null,"lastSeq":0,"count":0,"gaps":[],"duplicates":[],"suppressedAtIngest":[],"gapEvents":[],"rejected":0}',
    `the agent's audit read returns the real audit body: ${agentAudit.body}`,
  );

  // -------------------------------------------------------------------------
  // One oRPC round trip and one streamed event, over the wire
  // -------------------------------------------------------------------------

  const client: ApiClient = createORPCClient(
    new FetchLink({
      url: `http://127.0.0.1:${apiPort}/rpc`,
      headers: { authorization: `Bearer ${token}`, origin },
    }),
  );

  const started = await client.start_run({ prompt: "verify the control plane" });
  const run = await client.get_run({ runId: started.runId });
  check(
    run.status === "running" && run.prompt === "verify the control plane" && run.lastSeq >= 2,
    `oRPC round trip: start_run + get_run -> ${JSON.stringify(run)}`,
  );

  const socket = new WebSocket(`ws://127.0.0.1:${apiPort}/rpc-ws?token=${token}`);
  const received: EventMessage[] = [];
  const drained = (async () => {
    try {
      const streamed: ApiClient = createORPCClient(new WebSocketLink({ websocket: socket }));
      for await (const message of await streamed.subscribe_events({ lastSeq: 0 })) {
        received.push(message);
      }
    } catch {
      // The client's iterator aborts when its socket closes, which is how this drain ends.
    }
  })();

  await until(() => received.length >= 2, "the replayed events");
  const cancelled = await client.cancel_run({ runId: started.runId });
  await until(() => received.length >= 3, "the live run.failed");
  socket.close();
  await drained;

  check(
    received.length === 3 &&
      received.every((message, index) => message.seq === index + 1) &&
      received.every((message) => safeParseMessage(message).success),
    `websocket stream seq ${received.map((message) => message.seq).join(",")}: ${received.map((message) => message.type).join(",")}`,
  );
  check(
    received[0]?.type === "run.started" &&
      received[0].runId === matrixRunId &&
      received[1]?.type === "run.started" &&
      received[1].runId === started.runId,
    `the replay covers both runs in order: ${received[0]?.runId} then ${received[1]?.runId}`,
  );
  check(
    received[2]?.type === "run.failed" &&
      JSON.stringify(received[2].payload) === '{"reason":"cancelled by operator"}' &&
      cancelled.runId === started.runId,
    `the live event is the cancel's run.failed: ${JSON.stringify(received[2])}`,
  );

  await Bun.sleep(100);
  const appearances = serverOutput.split(token).length - 1;
  check(
    appearances === 1,
    `the token appears exactly once in the server's output (${appearances}): only the operator line carries it`,
  );
  const authLines = serverOutput.match(/\[auth\][^\n]*/g) ?? [];
  check(
    authLines.length >= 4 && authLines.every((line) => !line.includes(token)),
    `refusals logged without the token: ${authLines.join(" | ")}`,
  );
} finally {
  server.kill();
  await server.exited;
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

const ok = failures.length === 0;
const report = [
  `feature: ${feature}`,
  "command: bun apps/server/scripts/verify.ts",
  `timestamp: ${new Date().toISOString()}`,
  `git sha: ${head}`,
  `git sha short: ${shortSha}`,
  `branch: ${branch}`,
  `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
  "",
  ...lines,
  "",
  `${ok ? "PASS" : "FAIL"} ${feature}`,
  "",
].join("\n");

if (launchToken !== undefined && report.includes(launchToken)) {
  console.error("refusing to write an artifact that contains the launch token");
  process.exit(1);
}

const dir = join(root, "packages", "verify", "artifacts", feature, shortSha);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "assert.txt"), report);

console.log(report);
console.log(`artifact: packages/verify/artifacts/${feature}/${shortSha}/assert.txt`);
process.exitCode = ok ? 0 : 1;
