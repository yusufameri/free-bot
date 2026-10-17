// Stub replay server for the web-stream spike: serves the page and replays the mapped
// transcript over /events, gating the marked destructive call on a real answer.
//
// Run alone to watch it: bun spikes/web-stream/stub-server.ts (open with ?auto=allow|deny)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { TranscriptLine } from "./envelope.ts";
import { DEFAULT_DESTRUCTIVE_TOOL_CALL_ID, displayFrames, parseTranscript } from "./map.ts";

const FIXTURE = new URL(
  "../../packages/verify/artifacts/tunnel/bf0a4e6/transcript.jsonl",
  import.meta.url,
).pathname;

export type StubOptions = {
  transcriptPath?: string;
  scenario?: string;
  destructiveToolCallId?: string;
  paceMs?: number;
  initialDelayMs?: number;
  answerTimeoutMs?: number;
};

type ConnData = {
  fromSeq: number;
  echoLast: boolean;
  dropAt: number | null;
  resolveAnswer: ((decision: "allow" | "deny" | null) => void) | null;
};

export type StubServer = {
  port: number;
  stop: () => void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function numberOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function startStubServer(opts: StubOptions = {}): Promise<StubServer> {
  const transcriptPath = opts.transcriptPath ?? FIXTURE;
  const scenario = opts.scenario ?? "a";
  const destructiveToolCallId = opts.destructiveToolCallId ?? DEFAULT_DESTRUCTIVE_TOOL_CALL_ID;
  const paceMs = opts.paceMs ?? 90;
  const initialDelayMs = opts.initialDelayMs ?? 500;
  const answerTimeoutMs = opts.answerTimeoutMs ?? 60_000;

  const lines: TranscriptLine[] = parseTranscript(readFileSync(transcriptPath, "utf8"), scenario);
  const pageHtml = readFileSync(join(import.meta.dir, "page.html"), "utf8");
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "app.ts")],
    target: "browser",
    format: "esm",
  });
  if (!build.success) throw new Error(`page bundle failed:\n${build.logs.join("\n")}`);
  const bundle = build.outputs[0];
  if (bundle === undefined) throw new Error("page bundle produced no output");
  const bundleJs = await bundle.text();

  let droppedOnce = false;

  async function waitAnswer(ws: ServerWebSocket<ConnData>): Promise<"allow" | "deny" | null> {
    const answered = new Promise<"allow" | "deny" | null>((resolve) => {
      ws.data.resolveAnswer = resolve;
    });
    const timedOut = sleep(answerTimeoutMs).then(() => null);
    const decision = await Promise.race([answered, timedOut]);
    ws.data.resolveAnswer = null;
    return decision;
  }

  async function replay(ws: ServerWebSocket<ConnData>): Promise<void> {
    const { fromSeq, echoLast, dropAt } = ws.data;
    if (fromSeq === 0) await sleep(initialDelayMs);
    let denyNext = false;
    for (const frame of displayFrames(lines, { destructiveToolCallId })) {
      if (frame.seq <= fromSeq && !(echoLast && frame.seq === fromSeq)) continue;
      if (frame.type === "approval_resolved" && frame.payload.decision === null) {
        const decision = await waitAnswer(ws);
        if (decision === null) {
          ws.close();
          return;
        }
        frame.payload.decision = decision;
        denyNext = decision === "deny";
      }
      if (frame.type === "tool_result" && denyNext) {
        frame.payload = {
          toolCallId: frame.payload.toolCallId,
          ok: false,
          denied: true,
          output: "denied: user denied approval",
          durationMs: null,
        };
        denyNext = false;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(frame));
      if (dropAt !== null && !droppedOnce && frame.seq >= dropAt) {
        droppedOnce = true;
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
            fromSeq: numberOrNull(url.searchParams.get("last_seen_seq")) ?? 0,
            echoLast: url.searchParams.get("echo_last") === "1",
            dropAt: numberOrNull(url.searchParams.get("drop_at")),
            resolveAnswer: null,
          },
        });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(pageHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/bundle.js") {
        return new Response(bundleJs, {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        void replay(ws);
      },
      message(ws, message) {
        const parsed = JSON.parse(String(message)) as { type?: string; decision?: string };
        if (
          parsed.type === "answer" &&
          (parsed.decision === "allow" || parsed.decision === "deny")
        ) {
          ws.data.resolveAnswer?.(parsed.decision);
        }
      },
      close(ws) {
        ws.data.resolveAnswer?.(null);
      },
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("stub server did not bind a TCP port");
  return {
    port,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const stub = await startStubServer();
  console.log(
    `web-stream stub: http://127.0.0.1:${stub.port}/ (add ?auto=allow or ?auto=deny to answer automatically)`,
  );
}
