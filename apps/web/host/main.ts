/**
 * The apps/web host: connect, hand every message to the shared thread model, and let it render.
 * Everything else (the model, the DOM contract) lives in `@freebot/ui`.
 *
 * The replay server is the only peer. No provider, no key, no network beyond localhost.
 */

import type { Message } from "../../../packages/protocol/src/index.ts";
import { type Connection, exposeFacts, mountThread } from "../../../packages/ui/browser/render.ts";

const params = new URLSearchParams(location.search);
const auto = params.get("auto");
const autoAnswer = auto === "allow" || auto === "deny" ? auto : null;

let socket: WebSocket | null = null;

const handle = mountThread({
  autoAnswer,
  onAnswer: (decision, approvalId) => {
    socket?.send(JSON.stringify({ type: "answer", decision, approvalId }));
  },
});
exposeFacts(handle);
window.__threadConnection = () => (handle.state().error === null ? "live" : "error");

declare global {
  interface Window {
    /** Test hook for the CDP driver: send one control message on the live socket. */
    __threadSend?: (message: unknown) => void;
  }
}

/** The driver releases a `hold_before` park through this, exactly as it would answer a card. */
window.__threadSend = (message: unknown): void => {
  socket?.send(JSON.stringify(message));
};

function connect(): void {
  const carry = new URLSearchParams();
  for (const key of ["drop_at", "echo_last", "auto", "hold_before"]) {
    const value = params.get(key);
    if (value !== null) carry.set(key, value);
  }
  carry.set("last_seen_seq", String(handle.state().lastSeq));
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/events?${carry.toString()}`);
  socket = ws;

  ws.onopen = () => {
    handle.setConnection("connected");
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    try {
      handle.apply(message);
    } catch (err) {
      handle.showError(err instanceof Error ? err.message : String(err));
      ws.close();
      return;
    }
    if (handle.state().error !== null) ws.close();
  };
  ws.onclose = () => {
    if (handle.state().error !== null) return;
    handle.setConnection("reconnecting");
    setTimeout(connect, 250);
  };
  ws.onerror = () => {
    if (handle.state().error !== null) return;
    handle.setConnection("reconnecting");
  };
}

const initial: Connection = "connecting";
handle.setConnection(initial);
connect();
