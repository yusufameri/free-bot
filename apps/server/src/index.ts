import { startApiServer } from "./api-server";
import { app } from "./app";
import { startTunnelServer } from "./tunnel";

export { app };

const tunnel = startTunnelServer({ port: Number(Bun.env.PORT ?? 0) });

console.log(`listening on http://127.0.0.1:${tunnel.port}`);

const api = startApiServer({ port: Number(Bun.env.API_PORT ?? 0) });

console.log(`control plane on http://127.0.0.1:${api.port}`);
console.log(`operator token: ${api.token}`);
