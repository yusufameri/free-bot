/**
 * The replay server: the surface's only peer. It serves the host page, replays one committed
 * fixture over `/events`, and drives the three stream behaviours the smoke proved on a real
 * socket: at-least-once resume (`echo_last`), a mid-stream disconnect (`drop_at`), and the gate's
 * hold (the stream parks at the parked call until the page answers).
 *
 * `hold_before` is this unit's addition: the stream parks before a named seq until the page sends
 * `{type: "resume"}`. Without it a capture of a transient state (a call that is `running`, a
 * decision that has landed but whose result has not) races the replay. Holds are consumed once, so
 * a rejoin does not park at a hold the first connection already passed.
 *
 * There is no model here and no network beyond 127.0.0.1. Run it alone to watch a replay:
 * `bun apps/web/scripts/server.ts allow`
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";
import type { EventMessage, Message } from "../../../packages/protocol/src/index.ts";
import { type FixtureVariant, fixtureDecision, loadFixture } from "./fixture.ts";

export const HOST_DIR = fileURLToPath(new URL("../host/", import.meta.url));

export interface ReplayOptions {
  variant: FixtureVariant;
  /** Milliseconds between replayed messages. */
  paceMs?: number;
  /** Quiet period before the first message, so a driver can capture the idle state. */
  initialDelayMs?: number;
  answerTimeoutMs?: number;
}

export interface ReplayServer {
  port: number;
  /** The fixture's last seq, so a driver can assert the terminal state without hardcoding it. */
  head: number;
  /** What the page answered, in order. A driver asserts this against the fixture's own decision. */
  answers: Array<"allow" | "deny">;
  stop(): void;
}

type ConnData = {
  fromSeq: number;
  echoLast: boolean;
  dropAt: number[];
  holds: number[];
  resolveResume: (() => void) | null;
  resolveAnswer: ((decision: "allow" | "deny" | null) => void) | null;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function numbersOrEmpty(raw: string | null): number[] {
  if (raw === null) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

export async function startReplayServer(opts: ReplayOptions): Promise<ReplayServer> {
  const paceMs = opts.paceMs ?? 45;
  const initialDelayMs = opts.initialDelayMs ?? 700;
  const answerTimeoutMs = opts.answerTimeoutMs ?? 30_000;

  const messages: EventMessage[] = loadFixture(opts.variant);
  const head = messages.at(-1)?.seq ?? 0;
  const decision = fixtureDecision(opts.variant);
  const html = readFileSync(join(HOST_DIR, "index.html"), "utf8");
  const build = await Bun.build({
    entrypoints: [join(HOST_DIR, "main.ts")],
    target: "browser",
    format: "esm",
  });
  if (!build.success) throw new Error(`host bundle failed:\n${build.logs.join("\n")}`);
  const bundle = build.outputs[0];
  if (bundle === undefined) throw new Error("host bundle produced no output");
  const bundleJs = await bundle.text();

  const consumedHolds = new Set<number>();
  const answers: Array<"allow" | "deny"> = [];
  let dropped = false;

  async function waitResume(ws: ServerWebSocket<ConnData>): Promise<void> {
    await new Promise<void>((resolve) => {
      ws.data.resolveResume = resolve;
    });
    ws.data.resolveResume = null;
  }

  async function waitAnswer(ws: ServerWebSocket<ConnData>): Promise<void> {
    const answered = new Promise<"allow" | "deny" | null>((resolve) => {
      ws.data.resolveAnswer = resolve;
    });
    const timedOut = sleep(answerTimeoutMs).then(() => null);
    const given = await Promise.race([answered, timedOut]);
    ws.data.resolveAnswer = null;
    if (given === null) throw new Error("the page never answered the parked approval");
    answers.push(given);
    if (given !== decision) {
      throw new Error(`the page answered ${given} but the fixture records ${decision}`);
    }
  }

  async function replay(ws: ServerWebSocket<ConnData>): Promise<void> {
    const { fromSeq, echoLast, dropAt, holds } = ws.data;
    const send = (message: Message): void => {
      ws.send(JSON.stringify(message));
    };
    send({ v: 1, type: "stream.hello", payload: { firstSeq: 1, lastSeq: head } });
    if (fromSeq > 0) {
      send({ v: 1, type: "stream.resumed", payload: { fromSeq, toSeq: head } });
    } else {
      await sleep(initialDelayMs);
    }
    for (const message of messages) {
      const seq = message.seq;
      if (seq <= fromSeq && !(echoLast && seq === fromSeq)) continue;
      if (holds.includes(seq) && !consumedHolds.has(seq)) {
        consumedHolds.add(seq);
        await waitResume(ws);
      }
      if (message.type === "approval.requested") {
        send(message);
        await waitAnswer(ws);
      } else {
        send(message);
      }
      if (dropAt.includes(seq) && !dropped) {
        dropped = true;
        await sleep(150);
        ws.close();
        return;
      }
      await sleep(paceMs);
    }
  }

  const server = Bun.serve<ConnData, Record<string, never>>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, bunServer) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const upgraded = bunServer.upgrade(req, {
          data: {
            fromSeq: Number(url.searchParams.get("last_seen_seq") ?? "0"),
            echoLast: url.searchParams.get("echo_last") === "1",
            dropAt: numbersOrEmpty(url.searchParams.get("drop_at")),
            holds: numbersOrEmpty(url.searchParams.get("hold_before")),
            resolveResume: null,
            resolveAnswer: null,
          },
        });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/main.js") {
        return new Response(bundleJs, {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        replay(ws).catch((err: unknown) => {
          console.error(`replay stopped: ${err instanceof Error ? err.message : String(err)}`);
          ws.close();
        });
      },
      message(ws, raw) {
        const parsed = JSON.parse(String(raw)) as { type?: string; decision?: string };
        if (parsed.type === "resume") ws.data.resolveResume?.();
        if (
          parsed.type === "answer" &&
          (parsed.decision === "allow" || parsed.decision === "deny")
        ) {
          ws.data.resolveAnswer?.(parsed.decision);
        }
      },
      close(ws) {
        ws.data.resolveResume?.();
        ws.data.resolveAnswer?.(null);
      },
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("the replay server did not bind a TCP port");
  return {
    port,
    head,
    answers,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const variant: FixtureVariant = process.argv[2] === "deny" ? "deny" : "allow";
  const server = await startReplayServer({ variant, paceMs: 90, initialDelayMs: 400 });
  console.log(
    `freebot thread replay (${variant}): http://127.0.0.1:${server.port}/?auto=allow (or ?auto=deny)`,
  );
}
