/**
 * The server process: the tunnel leg, the operator API, and the page's stream.
 *
 * `startServer` boots both listeners and hands back their ports and the operator token, so a
 * launcher can compose the same two servers with its own run authority (`bun run up`, which injects
 * a sandbox that remembers the containers it created). Run directly, this file prints the three
 * lines the evidence scripts read: the tunnel port, the control plane's port, and the token.
 */

import { startApiServer } from "./api-server";
import { app } from "./app";
import { createRunService, type RunService } from "./run-service";
import { startTunnelServer } from "./tunnel";

export { app };

export interface Server {
  /** The tunnel leg's port. */
  tunnelPort: number;
  /** The page, its stream and `/rpc` all answer here. */
  apiPort: number;
  /** The token this launch accepts. Printed once by the entrypoint, never logged per request. */
  token: string;
  /** Close both listeners. */
  stop(): void;
}

export interface ServerOptions {
  /** The tunnel leg's port. Defaults to 0, which asks the OS for a free one. */
  tunnelPort?: number;
  /** The page and its stream. Defaults to 0, which asks the OS for a free one. */
  apiPort?: number;
  /** The run authority, so a launcher can hand each run its own sandbox. */
  service?: RunService;
}

export function startServer(options: ServerOptions = {}): Server {
  const tunnel = startTunnelServer({ port: options.tunnelPort ?? 0 });
  let api: ReturnType<typeof startApiServer>;
  try {
    // One run authority: the operator API, the page and the page's stream all drive this instance.
    api = startApiServer({
      port: options.apiPort ?? 0,
      service: options.service ?? createRunService(),
    });
  } catch (error) {
    // A port this process cannot take must not leave the tunnel leg listening behind it.
    tunnel.stop();
    throw error;
  }
  return {
    tunnelPort: tunnel.port,
    apiPort: api.port,
    token: api.token,
    stop: () => {
      api.stop();
      tunnel.stop();
    },
  };
}

if (import.meta.main) {
  const server = startServer({
    tunnelPort: Number(Bun.env.PORT ?? 0),
    apiPort: Number(Bun.env.API_PORT ?? 0),
  });
  console.log(`listening on http://127.0.0.1:${server.tunnelPort}`);
  console.log(`control plane on http://127.0.0.1:${server.apiPort}`);
  console.log(`operator token: ${server.token}`);
}
