#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDir } from "./src/index";

const root = fileURLToPath(new URL("../..", import.meta.url));
const feature = "scaffold";

type Outcome = { ok: boolean; output: string };

function shell(cmd: string[]): Outcome {
  const proc = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return { ok: proc.exitCode === 0, output };
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString().trim();
}

async function listeningPort(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`server exited before reporting a port: ${buffer}`);
      buffer += decoder.decode(value, { stream: true });
      const port = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      if (port !== undefined) {
        return Number(port);
      }
    }
  })();
  read.catch(() => {});

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`server did not report a port within ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function healthz(): Promise<Outcome> {
  const server = Bun.spawn(["bun", "apps/server/src/index.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const port = await listeningPort(server.stdout, 10_000);
    const proc = Bun.spawnSync(
      [
        "curl",
        "-sS",
        "--max-time",
        "5",
        "-w",
        "\n%{http_code}",
        `http://127.0.0.1:${port}/healthz`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      return {
        ok: false,
        output: `curl exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`,
      };
    }
    const raw = proc.stdout.toString().trim();
    const cut = raw.lastIndexOf("\n");
    const body = raw.slice(0, cut).trim();
    const code = raw.slice(cut + 1).trim();
    let actual: unknown;
    try {
      actual = JSON.parse(body);
    } catch {
      return { ok: false, output: `GET /healthz -> ${code}, body was not JSON: ${body}` };
    }
    const expected = { status: "ok", service: "freebot-server" };
    const ok = code === "200" && JSON.stringify(actual) === JSON.stringify(expected);
    return { ok, output: `GET /healthz -> ${code} ${body}` };
  } finally {
    server.kill();
    await server.exited;
  }
}

/** Bun prints a failing file's errors first and its summary last, so keep both ends of the output. */
function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 2);
  return `${text.slice(0, head)}\n[...]\n${text.slice(-(max - head))}`;
}

const steps: Array<[string, () => Outcome | Promise<Outcome>]> = [
  ["typecheck", () => shell(["bun", "run", "typecheck"])],
  ["tests", () => shell(["bun", "run", "test"])],
  ["index-check", () => shell(["bun", "packages/verify/scripts/index-check.ts"])],
  ["scaffold-shape", () => shell(["sh", "packages/verify/features/scaffold.sh"])],
  // Order 36's hard pixel gate. One command, one browser, nine viewports; it exits non-zero on a
  // chrome mismatch or an undeclared box delta, so this step is the arming.
  ["pixel-gate", () => shell(["bun", "packages/pixel-gate/src/cli.ts", "--no-write"])],
  ["healthz", healthz],
];

const outcomes: Array<{ name: string; outcome: Outcome }> = [];

for (const [name, run] of steps) {
  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (error) {
    outcome = { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
  outcomes.push({ name, outcome });
  console.log(
    `${outcome.ok ? "PASS" : "FAIL"} step ${name}${outcome.ok ? ` (${outcome.output.split("\n")[0]})` : ""}`,
  );
  if (!outcome.ok) {
    console.log(truncate(outcome.output));
  }
}

const ok = outcomes.every((entry) => entry.outcome.ok);
const sha = git(["rev-parse", "HEAD"]);
const shortSha = git(["rev-parse", "--short", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

const report = [
  `feature: ${feature}`,
  "command: bun run verify",
  `timestamp: ${new Date().toISOString()}`,
  `git sha: ${sha}`,
  `git sha short: ${shortSha}`,
  `branch: ${branch}`,
  `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
  "",
  ...outcomes.map((entry) => `step ${entry.name}: ${entry.outcome.ok ? "PASS" : "FAIL"}`),
  ...outcomes
    .filter((entry) => !entry.outcome.ok)
    .flatMap((entry) => ["", `--- failed step ${entry.name} ---`, truncate(entry.outcome.output)]),
  "",
  `${ok ? "PASS" : "FAIL"} ${feature}`,
  "",
].join("\n");

const dir = artifactDir(root, feature, shortSha);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "assert.txt"), report);

console.log(`artifact: packages/verify/artifacts/${feature}/${shortSha}/assert.txt`);
console.log(`${ok ? "PASS" : "FAIL"} ${feature}`);
process.exitCode = ok ? 0 : 1;
