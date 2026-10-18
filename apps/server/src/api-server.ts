/**
 * The operator-facing API server: the one run authority, the page that drives it, and the stream.
 *
 * One `RunService` serves every surface here. `POST /rpc/<procedure>` carries the unary procedures
 * through oRPC's fetch adapter and `ws://…/rpc-ws` carries the same router through the Bun
 * WebSocket adapter, where `subscribe_events` streams. `GET /` serves the web host's page and
 * `ws://…/events` is the page's transport: the named thread's log, in the shape the page already
 * renders, plus the two control messages the page sends (`start`, `answer`). There is no second run
 * path: every one of them lands on `service.start`, `service.cancel` or `service.answer`.
 *
 * The page's stream names the thread it is watching, because a log belongs to a thread. A socket
 * that asks for no thread, or for one this server does not hold, is refused before the upgrade
 * rather than served an empty stream.
 *
 * Both socket legs and `/rpc` run the same gate (`auth.ts`) before any handler runs, so an
 * unauthenticated caller cannot reach a procedure, an upgrade, or the page's stream. The gate on
 * the WebSocket legs reads the token from the query string, because a browser cannot set headers on
 * a WebSocket.
 *
 * `GET /healthz` and the page itself answer behind only the Host check. `healthz` is a liveness
 * probe the launcher asks first; the page is static markup that carries no run state, and the token
 * it needs travels in the URL fragment the browser never sends to a server.
 *
 * Each socket gets its own `AbortController`, aborted on close, so a subscription stops waiting for
 * a log append the moment its caller goes away instead of leaking a waiter.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RPCHandler as BunWebSocketHandler } from "@orpc/server/bun-ws";
import { RPCHandler as FetchHandler } from "@orpc/server/fetch";
import { app } from "./app.ts";
import {
  type AuthRefusal,
  authorize,
  checkHost,
  mintToken,
  refusalLogLine,
  refusalResponse,
} from "./auth.ts";
import { createApiRouter } from "./router.ts";
import { createRunService, type RunService } from "./run-service.ts";

const HOST_DIR = fileURLToPath(new URL("../../web/host/", import.meta.url));

interface SocketData {
  kind: "rpc" | "events";
  abort: AbortController;
  /** The thread this socket is watching, and the `last_seen_seq` it asked to resume from. */
  threadId: string | null;
  lastSeenSeq: number;
}

export interface ApiServer {
  port: number;
  /** The token this launch accepted. Printed once by the entrypoint, never logged per request. */
  token: string;
  /** The one run authority every surface here drives. */
  service: RunService;
  stop(): void;
}

export interface ApiServerOptions {
  port?: number;
  /** Injected by a launcher that mints the token itself; otherwise a fresh one is minted here. */
  token?: string;
  /** Injected by the entrypoint and by tests. Defaults to a service with the real ports. */
  service?: RunService;
  /** Where the web host's page lives. Defaults to this repo's `apps/web/host`. */
  hostDir?: string;
}

export function startApiServer(options: ApiServerOptions = {}): ApiServer {
  const token = options.token ?? mintToken();
  const service = options.service ?? createRunService();
  const hostDir = options.hostDir ?? HOST_DIR;
  const router = createApiRouter(service);
  const http = new FetchHandler(router);
  const socket = new BunWebSocketHandler(router);

  /** Built once, on the first request for the page, so starting a server costs nothing. */
  let page: Promise<{ html: string; js: string }> | null = null;

  function hostPage(): Promise<{ html: string; js: string }> {
    page ??= (async () => {
      const build = await Bun.build({
        entrypoints: [join(hostDir, "main.ts")],
        target: "browser",
        format: "esm",
      });
      if (!build.success) throw new Error(`host bundle failed:\n${build.logs.join("\n")}`);
      const bundle = build.outputs[0];
      if (bundle === undefined) throw new Error("host bundle produced no output");
      return { html: readFileSync(join(hostDir, "index.html"), "utf8"), js: await bundle.text() };
    })();
    return page;
  }

  const server = Bun.serve<SocketData, Record<string, never>>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      const path = url.pathname;

      const hostRefusal = checkHost(request.headers.get("host"));
      if (hostRefusal !== null) return refuse(hostRefusal, request);

      if (path === "/events") {
        const refusal = authorize(request, token, { tokenFromQuery: true });
        if (refusal !== null) return refuse(refusal, request);
        const requested = Number(url.searchParams.get("last_seen_seq") ?? "0");
        const lastSeenSeq = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
        const threadId = url.searchParams.get("thread_id");
        if (threadId === null) {
          // The stream is a thread's. Without one there is no log to follow, and guessing a thread
          // would hand the caller a conversation they did not name.
          return new Response("this stream needs a thread_id", { status: 400 });
        }
        if (service.registry.thread(threadId) === undefined) {
          return new Response(`no such thread: ${threadId}`, { status: 404 });
        }
        if (
          srv.upgrade(request, {
            data: { kind: "events", abort: new AbortController(), threadId, lastSeenSeq },
          })
        )
          return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
      }

      if (path === "/rpc-ws") {
        const refusal = authorize(request, token, { tokenFromQuery: true });
        if (refusal !== null) return refuse(refusal, request);
        const data: SocketData = {
          kind: "rpc",
          abort: new AbortController(),
          threadId: null,
          lastSeenSeq: 0,
        };
        if (srv.upgrade(request, { data })) return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
      }

      if (path === "/rpc" || path.startsWith("/rpc/")) {
        const refusal = authorize(request, token);
        if (refusal !== null) return refuse(refusal, request);
        const result = await http.handle(request, {
          prefix: "/rpc",
          context: { signal: undefined },
        });
        return result.matched
          ? result.response
          : new Response("no such procedure", { status: 404 });
      }

      if (path === "/" || path === "/index.html") {
        const { html } = await hostPage();
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (path === "/main.js") {
        const { js } = await hostPage();
        return new Response(js, {
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      }

      return app.fetch(request);
    },
    websocket: {
      open(ws) {
        if (ws.data.kind !== "events") return;
        const threadId = ws.data.threadId ?? "";
        const audit = service.audit(threadId);
        send(ws, {
          v: 1,
          type: "stream.hello",
          payload: { firstSeq: audit.firstSeq, lastSeq: audit.lastSeq },
        });
        if (ws.data.lastSeenSeq > 0) {
          send(ws, {
            v: 1,
            type: "stream.resumed",
            payload: { fromSeq: ws.data.lastSeenSeq, toSeq: audit.lastSeq },
          });
        }
        void pump(ws);
      },
      async message(ws, message) {
        if (ws.data.kind === "rpc") {
          await socket.message(ws, message, { context: { signal: ws.data.abort.signal } });
          return;
        }
        control(typeof message === "string" ? message : message.toString("utf8"));
      },
      close(ws) {
        if (ws.data.kind === "rpc") socket.close(ws);
        ws.data.abort.abort();
      },
    },
  });

  /** Follow the thread's log to the page, from where it left off. */
  async function pump(ws: Bun.ServerWebSocket<SocketData>): Promise<void> {
    try {
      for await (const message of service.stream(
        ws.data.threadId ?? "",
        ws.data.lastSeenSeq,
        ws.data.abort.signal,
      )) {
        send(ws, message);
      }
    } catch {
      // A send on a socket that has gone away ends the pump; the close handler already cleaned up.
    } finally {
      ws.close();
    }
  }

  /** The page's two control messages. Both land on the one run authority. */
  function control(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as {
      type?: unknown;
      decision?: unknown;
      approvalId?: unknown;
      prompt?: unknown;
      botId?: unknown;
      threadId?: unknown;
    };
    if (
      message.type === "answer" &&
      (message.decision === "allow" || message.decision === "deny") &&
      typeof message.approvalId === "string"
    ) {
      service.answer(message.approvalId, message.decision);
      return;
    }
    if (
      message.type === "start" &&
      typeof message.prompt === "string" &&
      message.prompt.length > 0 &&
      typeof message.botId === "string" &&
      typeof message.threadId === "string"
    ) {
      // The page names the Bot and the thread it is showing, so a run lands in the conversation the
      // person is looking at. A control message that names neither is not a run request.
      service.start({ prompt: message.prompt, botId: message.botId, threadId: message.threadId });
    }
  }

  function send(ws: Bun.ServerWebSocket<SocketData>, message: unknown): void {
    ws.send(JSON.stringify(message));
  }

  function refuse(refusal: AuthRefusal, request: Request): Response {
    console.log(refusalLogLine(refusal, request));
    return refusalResponse(refusal);
  }

  return {
    port: server.port ?? 0,
    token,
    service,
    stop: () => server.stop(true),
  };
}
