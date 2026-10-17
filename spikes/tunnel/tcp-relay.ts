/**
 * The tunnel carriage: a byte-transparent TCP relay the container's agent dials through to reach
 * the control plane. The harness SIGKILLs this process to drop the tunnel the way a real
 * middlebox dies: mid-frame, with no close handshake on either side.
 */

import { connect, createServer } from "node:net";

function flag(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index === -1 ? undefined : Bun.argv[index + 1];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

const listen = Number(flag("--listen"));
const forward = Number(flag("--forward"));

const server = createServer((client) => {
  const upstream = connect({ host: "127.0.0.1", port: forward });
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});

server.listen(listen, "0.0.0.0", () => {
  console.log(`[relay] listening on 0.0.0.0:${listen} -> 127.0.0.1:${forward}`);
});
