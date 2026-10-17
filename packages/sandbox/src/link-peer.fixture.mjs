/**
 * The tunnel-echo fixture: a link peer the integration test starts inside the sandbox. It is
 * supervisor-shaped (it writes `attached` on every attach) and speaks the landed framing module
 * `link.ts`, which the test uploads next to it, so the adapter's duplex is exercised against the
 * real wire shape rather than a second copy of it.
 *
 * For every agent `ack` it answers with one real frame type, `agent_settled`, stamped with the same
 * seq. That is the echo: a round trip that leaves the host as an ack and returns as a frame.
 *
 * Usage: node peer.mjs <port-file>
 */

import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { encodeLine, splitLines } from "./link.ts";

const portFile = process.argv[2];
if (portFile === undefined) throw new Error("usage: node peer.mjs <port-file>");

let buffer = "";
const server = createServer((peer) => {
  peer.write(encodeLine({ kind: "attached", acked: 0, lastSeq: 0 }));
  peer.on("data", (chunk) => {
    const split = splitLines(buffer, chunk.toString("utf8"));
    buffer = split.rest;
    for (const line of split.lines) {
      const message = JSON.parse(line);
      if (message.kind === "ack") {
        peer.write(
          encodeLine({ kind: "frame", seq: message.seq, frame: { type: "agent_settled" } }),
        );
      }
    }
  });
  peer.on("error", () => peer.destroy());
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  writeFileSync(portFile, `${address.port}\n`);
  console.log(`[peer] listening port=${address.port}`);
});
