import { app } from "./app";
import { startTunnelServer } from "./tunnel";

export { app };

const server = startTunnelServer({ port: Number(Bun.env.PORT ?? 0) });

console.log(`listening on http://127.0.0.1:${server.port}`);
