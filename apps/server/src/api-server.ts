/**
 * The operator-facing API server: loopback only, one gate, two transports over one router.
 *
 * `POST /rpc/<procedure>` carries the unary procedures through oRPC's fetch adapter;
 * `ws://…/rpc-ws` carries the same router through the Bun WebSocket adapter, where
 * `subscribe_events` streams. Both paths run the same gate (`auth.ts`) before any handler runs, so
 * an unauthenticated caller cannot reach a procedure or an upgrade.
 *
 * `GET /healthz` answers behind only the Host check: it is a liveness probe that returns two
 * constant fields, and the launcher's first question about the server is whether it is up. Every
 * other route needs the token.
 *
 * Each socket gets its own `AbortController`, aborted on close, so a subscription stops waiting for
 * a log append the moment its caller goes away instead of leaking a waiter.
 */

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
import { ControlPlane } from "./control-plane.ts";
import { createApiRouter } from "./router.ts";

interface SocketData {
  abort: AbortController;
}

export interface ApiServer {
  port: number;
  /** The token this launch accepted. Printed once by the entrypoint, never logged per request. */
  token: string;
  control: ControlPlane;
  stop(): void;
}

export interface ApiServerOptions {
  port?: number;
  /** Injected by a launcher that mints the token itself; otherwise a fresh one is minted here. */
  token?: string;
}

export function startApiServer(options: ApiServerOptions = {}): ApiServer {
  const token = options.token ?? mintToken();
  const control = new ControlPlane();
  const router = createApiRouter(control);
  const http = new FetchHandler(router);
  const socket = new BunWebSocketHandler(router);

  const server = Bun.serve<SocketData, Record<string, never>>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request, srv) {
      const path = new URL(request.url).pathname;

      const hostRefusal = checkHost(request.headers.get("host"));
      if (hostRefusal !== null) return refuse(hostRefusal, request);

      if (path === "/rpc-ws") {
        const refusal = authorize(request, token, { tokenFromQuery: true });
        if (refusal !== null) return refuse(refusal, request);
        const data: SocketData = { abort: new AbortController() };
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

      return app.fetch(request);
    },
    websocket: {
      async message(ws, message) {
        await socket.message(ws, message, {
          context: { signal: ws.data.abort.signal },
        });
      },
      close(ws) {
        socket.close(ws);
        ws.data.abort.abort();
      },
    },
  });

  function refuse(refusal: AuthRefusal, request: Request): Response {
    console.log(refusalLogLine(refusal, request));
    return refusalResponse(refusal);
  }

  return {
    port: server.port ?? 0,
    token,
    control,
    stop: () => server.stop(true),
  };
}
