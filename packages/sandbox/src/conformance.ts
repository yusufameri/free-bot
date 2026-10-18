/**
 * The sandbox conformance suite (U9.1, plan Part 12). One suite names what a sandbox backend must
 * do; Docker is the reference implementation and passes it. A second backend (microsandbox, E2B
 * Embed) runs this function and is a pass or a failure rather than a rewrite.
 *
 * A subject is the frozen `SandboxProvider` (plan 2.6) plus an `SandboxOwnership` port. The port
 * exists because the interface does not carry two things the suite must assert: what a backend's
 * engine holds behind a sandbox id (liveness plus the ownership labels), and the order-22
 * label-scoped cleanup. `docs/sandbox-conformance.md` names both as interface gaps rather than
 * growing the frozen surface here.
 *
 * Every assertion is written once, as a literal expected value, inside the operation that observes
 * it. The suite reports what it saw, so an artifact carries the facts rather than a verdict.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { encodeLine, splitLines } from "@freebot/sandbox-agent";
import {
  containerName,
  DEFAULT_STATE_DIR,
  DEFAULT_UNIT,
  DockerAdapter,
  PROVIDER_LABEL,
  SANDBOX_LABEL,
  UNIT_LABEL,
} from "./docker.ts";
import { dockerCli, dockerOutcome } from "./docker-cli.ts";
import { ensurePinnedImage, REPO_ROOT } from "./image.ts";
import {
  type DetachedExec,
  type ExecOptions,
  type ExecResult,
  type ExecStream,
  SandboxError,
  type SandboxHandle,
  type SandboxProvider,
} from "./interface.ts";

/** The operations, in the order the suite runs them. Later operations use earlier ones' state. */
export const CONFORMANCE_OPERATIONS = [
  "create",
  "exec",
  "upload",
  "download",
  "tunnel",
  "snapshot-resume",
  "idle-kill",
  "sweep",
] as const;

export type ConformanceOperation = (typeof CONFORMANCE_OPERATIONS)[number];

export interface ConformanceImage {
  /** The reference the suite passes as `spec.image`. */
  readonly ref: string;
  /** What the backend observed about that image before any sandbox existed. */
  readonly identity: string;
}

/** What a backend's engine holds behind a sandbox id: the facts a handle cannot carry. */
export interface OwnerFact {
  /** The engine's short id, the same 12 characters `docker ps` prints. */
  readonly id: string;
  readonly running: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

/** A sandbox this run created and must not sweep. */
export interface ConformanceDecoy {
  readonly name: string;
  /** Why this decoy exists, printed in the census. */
  readonly why: string;
}

/**
 * The backend's ownership operations. Docker's `sweep()` and its `ps`/`inspect` census are the
 * reference; a second backend answers the same questions through its own engine.
 */
export interface SandboxOwnership {
  /** The ownership label value this run carries. `sweep()` is scoped to it and to nothing else. */
  readonly unit: string;
  /** Remove exactly this run's sandboxes and return their engine ids. */
  sweep(): Promise<readonly string[]>;
  /** What the engine holds for a sandbox id, or null when it holds nothing. */
  inspect(id: string): Promise<OwnerFact | null>;
  /** Create the sandboxes this run must not sweep. */
  addDecoys(): Promise<readonly ConformanceDecoy[]>;
  /** One decoy's engine identity and liveness, as the census prints it. */
  observeDecoy(decoy: ConformanceDecoy): Promise<string>;
  removeDecoys(decoys: readonly ConformanceDecoy[]): Promise<void>;
}

export interface ConformanceSubject {
  /** This run's token. Every sandbox it creates is named `<case>-<id>`. */
  readonly id: string;
  /** The in-sandbox directory the backend's agent link uses; `create` makes it. */
  readonly stateDir: string;
  readonly provider: SandboxProvider;
  /** Resolve and validate the image every sandbox this run boots from. */
  image(): Promise<ConformanceImage>;
  readonly ownership: SandboxOwnership;
}

export interface ConformanceOperationResult {
  readonly operation: ConformanceOperation;
  readonly ok: boolean;
  /** The literal facts this operation produced, in the order it produced them. */
  readonly lines: readonly string[];
  /** The literal mismatch when it failed. */
  readonly error: string | null;
}

export interface ConformanceResult {
  /** True only when every operation ran and passed. */
  readonly ok: boolean;
  readonly operations: readonly ConformanceOperationResult[];
  readonly decoys: readonly ConformanceDecoy[];
}

export interface ConformanceRunOptions {
  /** Local directory for the bytes that go in and out. */
  readonly scratch: string;
  readonly report: (line: string) => void;
}

interface RunState {
  readonly subject: ConformanceSubject;
  readonly image: ConformanceImage;
  readonly decoys: readonly ConformanceDecoy[];
  readonly scratch: string;
  readonly owned: SandboxHandle[];
  main: SandboxHandle | null;
  /** The 4096 bytes `upload` put in, which `download` must read back byte for byte. */
  bytes: Buffer | null;
}

type Step = (state: RunState, line: (text: string) => void) => Promise<void>;

function render(value: unknown): string {
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString("utf8"));
  return JSON.stringify(value);
}

/** Compare and, on a mismatch, fail with both literals in the message. */
function same(actual: unknown, expected: unknown, what: string): void {
  const wanted = render(expected);
  const got = render(actual);
  if (wanted !== got) throw new Error(`${what}: expected ${wanted}, got ${got}`);
}

function mainOf(state: RunState): SandboxHandle {
  if (state.main === null) throw new Error("create ran no sandbox");
  return state.main;
}

/** Create one sandbox this run owns, named for the case it serves. */
async function owned(
  state: RunState,
  kind: string,
  extra: { readonly image?: string; readonly idleTtlMs?: number } = {},
): Promise<SandboxHandle> {
  const name = `${kind}-${state.subject.id}`;
  const handle = await state.subject.provider.create({
    name,
    image: extra.image ?? state.image.ref,
    stateDir: state.subject.stateDir,
    ...(extra.idleTtlMs === undefined ? {} : { idleTtlMs: extra.idleTtlMs }),
  });
  state.owned.push(handle);
  same(handle.provider, state.subject.provider.id, "create returned the subject's own provider id");
  same(handle.id, name, "create returned the name it was given");
  return handle;
}

/** Read the engine's own account of a sandbox, failing when it holds nothing. */
async function factOf(state: RunState, handle: SandboxHandle, what: string): Promise<OwnerFact> {
  const fact = await state.subject.ownership.inspect(handle.id);
  if (fact === null) throw new Error(`${what}: the engine holds no sandbox named ${handle.id}`);
  return fact;
}

async function until(read: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** One JSONL line per line, off a duplex, with the framing the link itself uses. */
function lineReader(stream: Duplex): (timeoutMs?: number) => Promise<string> {
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  stream.on("data", (chunk: Buffer) => {
    const split = splitLines(buffer, chunk.toString("utf8"));
    buffer = split.rest;
    for (const line of split.lines) {
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(line);
      else waiter(line);
    }
  });
  return (timeoutMs = 5000) => {
    const ready = queued.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no line within timeout")), timeoutMs);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  };
}

const createStep: Step = async (state, line) => {
  const handle = await owned(state, "u91-main");
  state.main = handle;
  const fact = await factOf(state, handle, "create");
  same(fact.running, true, "the sandbox runs after create");
  same(fact.labels[UNIT_LABEL], state.subject.ownership.unit, "the run's ownership label");
  same(fact.labels[SANDBOX_LABEL], handle.id, "the sandbox label carries the sandbox id");
  same(fact.labels[PROVIDER_LABEL], state.subject.provider.id, "the provider label");
  line(
    `check create: handle=${render(handle)} engine=${fact.id} running=${fact.running} labels=${render(fact.labels)}`,
  );

  // The pinned image proves itself from inside: node's version and Pi's version are the image's own
  // answers, rather than a constant this suite restates.
  const provider = state.subject.provider;
  const node = await provider.exec(handle, ["node", "--version"]);
  same(node.exitCode, 0, "node --version exit code");
  same(node.stdout.toString(), "v24.22.0\n", "node --version stdout");
  const pi = await provider.exec(handle, ["pi", "--version"]);
  same(pi.exitCode, 0, "pi --version exit code");
  same(pi.stdout.toString(), "1.3.0\n", "pi --version stdout");
  line(
    `check pinned image: ${state.image.identity}; in the sandbox node=${render(node.stdout.toString())} pi=${render(pi.stdout.toString())}`,
  );
};

const execStep: Step = async (state, line) => {
  const provider = state.subject.provider;
  const handle = mainOf(state);

  const plain = await provider.exec(handle, ["bash", "-c", "echo hello-from-sandbox"]);
  same(plain.exitCode, 0, "a buffered exec's exit code");
  same(plain.stdout.toString(), "hello-from-sandbox\n", "a buffered exec's stdout");
  same(plain.stderr.toString(), "", "a buffered exec's stderr");
  line(
    `check exec buffered: exit=${plain.exitCode} stdout=${render(plain.stdout.toString())} stderr=${render(plain.stderr.toString())}`,
  );

  const streamed = await provider.exec(
    handle,
    ["bash", "-c", "printf 'stream-one\\nstream-two\\n'"],
    { stream: true },
  );
  let chunks = "";
  streamed.stdout.on("data", (chunk: Buffer) => {
    chunks += chunk.toString("utf8");
  });
  const outcome = await streamed.result;
  same(outcome.exitCode, 0, "a streamed exec's exit code");
  same(chunks, "stream-one\nstream-two\n", "the bytes a streamed exec emitted");
  line(`check exec streamed: exit=${outcome.exitCode} stdout=${render(chunks)}`);

  const failed = await provider.exec(handle, ["bash", "-c", "exit 7"]);
  same(failed.exitCode, 7, "the exit code of a command that failed");
  same(failed.stdout.toString(), "", "the stdout of a command that failed");
  line(`check exec exit code: exit=${failed.exitCode} for "exit 7"`);

  const marker = `${state.subject.stateDir}/detached.txt`;
  const started = await provider.exec(
    handle,
    ["bash", "-c", `sleep 0.5 && printf detached-marker > ${marker}`],
    { detached: true },
  );
  same(started.started, true, "a detached exec's own answer");
  let content = "";
  const appeared = await until(async () => {
    const read = await provider.exec(handle, ["cat", marker]);
    content = read.exitCode === 0 ? read.stdout.toString() : "";
    return content !== "";
  }, 10_000);
  same(appeared, true, "the marker a detached exec wrote, read back after the call returned");
  same(content, "detached-marker", "the detached marker's bytes");
  line(`check exec detached: {started:true} then ${render(content)} read back`);
};

const uploadStep: Step = async (state, line) => {
  const provider = state.subject.provider;
  const handle = mainOf(state);
  const bytes = randomBytes(4096);
  state.bytes = bytes;
  const localPath = join(state.scratch, "up.bin");
  writeFileSync(localPath, bytes);
  const remotePath = `${state.subject.stateDir}/up.bin`;
  await provider.upload(handle, localPath, remotePath);
  const sha = await provider.exec(handle, ["sha256sum", remotePath]);
  same(sha.exitCode, 0, "the sandbox's own sha256sum of the uploaded file");
  const inside = sha.stdout.toString().trim().split(/\s+/)[0] ?? "";
  const outside = createHash("sha256").update(bytes).digest("hex");
  same(inside, outside, "the uploaded bytes, hashed inside the sandbox");
  line(
    `check upload: bytes=${bytes.length} host sha256=${outside} the sandbox's sha256sum=${inside} path=${remotePath}`,
  );
};

const downloadStep: Step = async (state, line) => {
  const provider = state.subject.provider;
  const handle = mainOf(state);
  const bytes = state.bytes;
  if (bytes === null) throw new Error("download ran before upload put any bytes in");
  const localPath = join(state.scratch, "down.bin");
  await provider.download(handle, `${state.subject.stateDir}/up.bin`, localPath);
  const downloaded = readFileSync(localPath);
  same(downloaded.length, 4096, "the downloaded file's length");
  same(downloaded.equals(bytes), true, "the downloaded bytes, byte-equal to the uploaded ones");
  line(
    `check download: bytes=${downloaded.length} byte-equal to the 4096 that went in sha256=${createHash("sha256").update(bytes).digest("hex")}`,
  );
};

const tunnelStep: Step = async (state, line) => {
  const provider = state.subject.provider;
  const handle = mainOf(state);
  const stateDir = state.subject.stateDir;
  const peerDir = `${stateDir}/link-peer`;
  await provider.exec(handle, ["mkdir", "-p", peerDir]);
  await provider.upload(
    handle,
    join(REPO_ROOT, "apps", "sandbox-agent", "src", "link.ts"),
    `${peerDir}/link.ts`,
  );
  await provider.upload(
    handle,
    fileURLToPath(new URL("./link-peer.fixture.mjs", import.meta.url)),
    `${peerDir}/peer.mjs`,
  );
  await provider.exec(
    handle,
    [
      "bash",
      "-c",
      `node ${peerDir}/peer.mjs ${stateDir}/supervisor.port > ${peerDir}/peer.log 2>&1`,
    ],
    { detached: true },
  );
  const listening = await until(async () => {
    const read = await provider.exec(handle, ["cat", `${stateDir}/supervisor.port`]);
    return read.exitCode === 0 && read.stdout.toString().trim() !== "";
  }, 10_000);
  same(listening, true, "the link peer inside the sandbox writing its port file");

  const duplex = await provider.tunnel(handle);
  try {
    const readLine = lineReader(duplex);
    const handshake = await readLine();
    same(
      JSON.parse(handshake),
      { kind: "attached", acked: 0, lastSeq: 0 },
      "the link's first line on the duplex",
    );
    duplex.write(encodeLine({ kind: "ack", seq: 7 }));
    const echo = await readLine();
    same(
      JSON.parse(echo),
      { kind: "frame", seq: 7, frame: { type: "agent_settled" } },
      "the frame the link echoed for ack seq 7",
    );
    line(`check tunnel handshake: ${handshake}`);
    line(`check tunnel echo: wrote {"kind":"ack","seq":7}, read back ${echo}`);
  } finally {
    // Destroying the duplex aborts any read in flight; that error belongs to the caller.
    duplex.on("error", () => {});
    duplex.destroy();
  }

  // The same operation with no link must be typed rather than silent.
  const noLink = await owned(state, "u91-no-link");
  const thrown: unknown = await provider.tunnel(noLink).then(
    () => null,
    (error: unknown) => error,
  );
  same(thrown instanceof SandboxError, true, "the error a tunnel with no link throws");
  const typed = thrown as SandboxError;
  same(typed.code, "link_error", "that error's code");
  same(typed.message.length > 0, true, "a message a person can read");
  line(`check tunnel without a link: code=${typed.code} message=${render(typed.message)}`);

  await provider.delete(noLink);
  same(await state.subject.ownership.inspect(noLink.id), null, "delete removing the sandbox");
  line(`check delete: ${noLink.id} is gone from the engine after delete()`);
};

const snapshotResumeStep: Step = async (state, line) => {
  const provider = state.subject.provider;
  const handle = mainOf(state);
  const marker = `${state.subject.stateDir}/marker.txt`;
  await provider.exec(handle, ["bash", "-c", `printf 'round-trip-marker\\n' > ${marker}`]);
  const snapshot = await provider.snapshot(handle, "u91-round-trip");
  same(snapshot.provider, provider.id, "the snapshot's provider");
  same(snapshot.handleId, handle.id, "the handle the snapshot was taken from");
  same(snapshot.tag, `freebot-snapshot/${handle.id}:u91-round-trip`, "the snapshot's tag");
  same(snapshot.ref.length > 0, true, "a reference a restore can boot from");
  line(`check snapshot: tag=${snapshot.tag} ref=${snapshot.ref} createdAt=${snapshot.createdAt}`);

  await provider.stop(handle);
  same((await factOf(state, handle, "stop")).running, false, "the sandbox after stop");
  await provider.resume(handle);
  same((await factOf(state, handle, "resume")).running, true, "the sandbox after resume");
  const kept = await provider.exec(handle, ["cat", marker]);
  same(kept.stdout.toString(), "round-trip-marker\n", "the disk state stop and resume kept");
  line(
    `check stop/resume: running -> not running -> running, marker=${render(kept.stdout.toString())}`,
  );

  const restored = await owned(state, "u91-restored", { image: snapshot.ref });
  const read = await provider.exec(restored, ["cat", marker]);
  same(
    read.stdout.toString(),
    "round-trip-marker\n",
    "the marker inside a sandbox booted from the snapshot",
  );
  line(
    `check restore: ${restored.id} booted from ${snapshot.ref} reads marker=${render(read.stdout.toString())}`,
  );
  await provider.delete(restored);
  same(
    await state.subject.ownership.inspect(restored.id),
    null,
    "delete removing the restored sandbox",
  );
  line(`check delete restored: ${restored.id} is gone from the engine`);
};

const idleKillStep: Step = async (state, line) => {
  const provider = state.subject.provider;
  const idleTtlMs = 600;
  const idler = await owned(state, "u91-idle", { idleTtlMs });
  const startedAt = Date.now();
  const stopped = await until(
    async () => (await state.subject.ownership.inspect(idler.id))?.running === false,
    15_000,
  );
  same(stopped, true, `a sandbox with idleTtlMs=${idleTtlMs} stopping with no adapter call`);
  line(
    `check idle-kill: ${idler.id} (idleTtlMs=${idleTtlMs}) stopped after ${Date.now() - startedAt}ms`,
  );
  await provider.resume(idler);
  for (let index = 0; index < 4; index += 1) {
    await provider.exec(idler, ["true"]);
    await Bun.sleep(200);
  }
  same(
    (await factOf(state, idler, "idle-touch")).running,
    true,
    "a sandbox still running after 4 calls at 200ms against a 600ms ttl",
  );
  line("check idle-touch: still running after 4 exec calls at 200ms intervals against a 600ms ttl");
};

const sweepStep: Step = async (state, line) => {
  const ownership = state.subject.ownership;
  const decoysBefore = new Map<string, string>();
  for (const decoy of state.decoys) {
    const observed = await ownership.observeDecoy(decoy);
    decoysBefore.set(decoy.name, observed);
    line(`census before sweep, decoy (${decoy.why}): ${observed}`);
    same(observed.endsWith("=gone"), false, `the decoy ${decoy.why} existing before the sweep`);
  }

  const live: string[] = [];
  for (const handle of state.owned) {
    const fact = await ownership.inspect(handle.id);
    line(`census before sweep, this run: ${handle.id}=${fact === null ? "gone" : fact.id}`);
    if (fact !== null) live.push(fact.id);
  }

  const removed = await ownership.sweep();
  same(
    [...removed].sort(),
    [...live].sort(),
    "the ids the sweep removed against the sandboxes this run still had",
  );
  line(
    `check sweep: removed ${removed.length} of ${live.length} live sandboxes: ${removed.join(", ")}`,
  );

  for (const handle of state.owned) {
    same(await ownership.inspect(handle.id), null, `the sweep removing ${handle.id}`);
  }
  line(
    `census after sweep, this run: 0 of the ${state.owned.length} sandboxes it created are left`,
  );

  for (const decoy of state.decoys) {
    same(
      await ownership.observeDecoy(decoy),
      decoysBefore.get(decoy.name),
      `the decoy ${decoy.why}`,
    );
    line(`census after sweep, decoy unchanged: ${decoysBefore.get(decoy.name)}`);
  }
};

const STEPS: Readonly<Record<ConformanceOperation, Step>> = {
  create: createStep,
  exec: execStep,
  upload: uploadStep,
  download: downloadStep,
  tunnel: tunnelStep,
  "snapshot-resume": snapshotResumeStep,
  "idle-kill": idleKillStep,
  sweep: sweepStep,
};

/**
 * Run every operation against one subject, in order, stopping at the first failure because each
 * later operation uses the state the earlier ones left. A failure is reported rather than thrown:
 * the caller's artifact must carry the operation that failed and the literal it saw.
 */
export async function runSandboxConformance(
  subject: ConformanceSubject,
  options: ConformanceRunOptions,
): Promise<ConformanceResult> {
  const image = await subject.image();
  const decoys = await subject.ownership.addDecoys();
  const state: RunState = {
    subject,
    image,
    decoys,
    scratch: options.scratch,
    owned: [],
    main: null,
    bytes: null,
  };
  const operations: ConformanceOperationResult[] = [];
  for (const operation of CONFORMANCE_OPERATIONS) {
    const lines: string[] = [];
    const line = (text: string) => {
      lines.push(text);
      options.report(text);
    };
    try {
      await STEPS[operation](state, line);
      operations.push({ operation, ok: true, lines, error: null });
    } catch (error) {
      operations.push({
        operation,
        ok: false,
        lines,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return {
    ok: operations.length === CONFORMANCE_OPERATIONS.length && operations.every((it) => it.ok),
    operations,
    decoys,
  };
}

/**
 * Forward every member to the real provider with the provider as the receiver, so the adapter's own
 * private state stays intact, and answer the overridden member with the sabotage.
 */
function wrapProvider(inner: SandboxProvider, override: Partial<SandboxProvider>): SandboxProvider {
  return new Proxy(inner, {
    get(target, property) {
      const replacement = (override as Record<string | symbol, unknown>)[property];
      if (replacement !== undefined) return replacement;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * The negative control: the same subject with one operation deliberately wrong, so a pass can be
 * told from a suite that cannot fail. Only the operations a wrapper can falsify from outside the
 * provider are supported, and each one is a defect this suite is supposed to catch rather than a
 * random lie: `exec` under-reports a success, `upload` moves the right number of wrong bytes, and
 * `sweep` removes the decoys it does not own. The sweep arm goes through the subject's own
 * ownership port, so the defect is seeded on whatever engine the subject runs on and a sabotaged
 * sweep fails there rather than passing silently; `decoys` is the list the caller gave its own
 * subject, so the sabotaged sweep still cannot reach a sandbox another unit made.
 */
export function sabotageOperation(
  subject: ConformanceSubject,
  operation: "exec" | "upload" | "sweep",
  decoys: readonly ConformanceDecoy[] = [],
): ConformanceSubject {
  const provider = subject.provider;
  if (operation === "exec") {
    // `create` proves the pinned image with two exec calls, so this sabotage surfaces there.
    const inner = provider.exec as unknown as (
      handle: SandboxHandle,
      cmd: readonly string[],
      options?: ExecOptions,
    ) => Promise<ExecResult | ExecStream | DetachedExec>;
    const lying = (async (
      handle: SandboxHandle,
      cmd: readonly string[],
      options?: ExecOptions,
    ): Promise<ExecResult | ExecStream | DetachedExec> => {
      const outcome = await inner(handle, cmd, options);
      if (options?.stream === true || options?.detached === true) return outcome;
      const result = outcome as ExecResult;
      return { ...result, exitCode: result.exitCode === 0 ? 1 : result.exitCode };
    }) as SandboxProvider["exec"];
    return { ...subject, provider: wrapProvider(provider, { exec: lying }) };
  }
  if (operation === "upload") {
    return {
      ...subject,
      provider: wrapProvider(provider, {
        upload: async (handle: SandboxHandle, localPath: string, remotePath: string) => {
          const wrong = `${localPath}.sabotaged`;
          writeFileSync(wrong, Buffer.alloc(readFileSync(localPath).length, 0x7f));
          await provider.upload(handle, wrong, remotePath);
        },
      }),
    };
  }
  return {
    ...subject,
    ownership: {
      ...subject.ownership,
      sweep: async () => {
        const removed = await subject.ownership.sweep();
        await subject.ownership.removeDecoys(decoys);
        return removed;
      },
    },
  };
}

export interface DockerDecoySpec {
  readonly name: string;
  /** The ownership label value it carries; null means it carries no labels at all. */
  readonly unit: string | null;
  readonly why: string;
}

export interface DockerConformanceOptions {
  /** This run's token. */
  readonly token: string;
  /** The containers the sweep must not touch. */
  readonly decoys: readonly DockerDecoySpec[];
}

/**
 * The Docker reference subject: the shipped adapter, the pinned image, and the ownership port
 * answered through the Docker CLI. `unit` is this run's own label value, which is what keeps
 * `sweep()` scoped to this run on a shared engine.
 */
export function dockerConformanceSubject(options: DockerConformanceOptions): ConformanceSubject {
  const unit = `${DEFAULT_UNIT}-run-${options.token}`;
  const adapter = new DockerAdapter({ unit });
  const decoys: readonly ConformanceDecoy[] = options.decoys.map(({ name, why }) => ({
    name,
    why,
  }));
  return {
    id: options.token,
    stateDir: DEFAULT_STATE_DIR,
    provider: adapter,
    image: async () => {
      const pinned = await ensurePinnedImage();
      return {
        ref: pinned.ref,
        identity: `${pinned.layers.length} RootFS layers equal the U0.6-recorded set`,
      };
    },
    ownership: {
      unit,
      sweep: () => adapter.sweep(),
      inspect: async (id) => {
        const name = containerName(id);
        const listed = await dockerCli([
          "ps",
          "-a",
          "--filter",
          `name=^${name}$`,
          "--format",
          "{{.Names}}",
        ]);
        if (listed === "") return null;
        const raw = await dockerCli([
          "inspect",
          "--format",
          "{{.Id}} {{.State.Running}} {{json .Config.Labels}}",
          name,
        ]);
        const parsed = /^(\S+) (\S+) (.*)$/.exec(raw);
        if (parsed === null) {
          throw new SandboxError(
            "docker_cli",
            `docker inspect ${name} returned ${JSON.stringify(raw)}`,
          );
        }
        return {
          // The 12-character prefix is what `docker ps` prints and what `sweep()` returns.
          id: (parsed[1] ?? "").slice(0, 12),
          running: parsed[2] === "true",
          labels: JSON.parse(parsed[3] === "" ? "{}" : (parsed[3] ?? "{}")) as Record<
            string,
            string
          >,
        };
      },
      addDecoys: async () => {
        const image = (await ensurePinnedImage()).ref;
        for (const spec of options.decoys) {
          const labels =
            spec.unit === null
              ? []
              : [
                  "--label",
                  `${UNIT_LABEL}=${spec.unit}`,
                  "--label",
                  `${SANDBOX_LABEL}=${spec.name}`,
                  "--label",
                  `${PROVIDER_LABEL}=docker`,
                ];
          await dockerCli([
            "run",
            "-d",
            "--name",
            spec.name,
            ...labels,
            image,
            "sleep",
            "infinity",
          ]);
        }
        return decoys;
      },
      observeDecoy: async (decoy) => {
        const outcome = await dockerOutcome([
          "inspect",
          "--format",
          "{{.Id}} {{.State.Status}}",
          decoy.name,
        ]);
        // Absence is a census fact rather than a CLI failure, so a swept decoy reads as `gone`
        // beside the fact it had before.
        if (outcome.exitCode !== 0) return `${decoy.name}=gone`;
        return `${decoy.name}=${outcome.stdout.toString("utf8").trim()}`;
      },
      removeDecoys: async (toRemove) => {
        for (const decoy of toRemove) await dockerCli(["rm", "-f", decoy.name]);
      },
    },
  };
}
