/**
 * The apps/web host: connect, hand every message to the shared thread model, and let it render.
 * Everything else (the model, the DOM contract) lives in `@freebot/ui`.
 *
 * Two peers, one page. The fixture server (`apps/web/scripts/server.ts`) is the dev peer: no token,
 * one committed replay. The real server serves this page and its stream, and its stream is gated by
 * the operator token, so the page presents the token it was opened with. The token rides in the URL
 * fragment, because a browser never sends a fragment to a server; only the WebSocket's query string
 * carries it, which is the one place the gate reads a token from a query.
 *
 * Operator mode is "the page was opened with a token". That is what reveals the prompt box, so the
 * fixture page renders exactly the page it rendered before this unit.
 */

import type { Message } from "../../../packages/protocol/src/index.ts";
import { type Connection, exposeFacts, mountThread } from "../../../packages/ui/browser/render.ts";

const params = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const token = fragment.get("token") ?? params.get("token");
const auto = params.get("auto");
const autoAnswer = auto === "allow" || auto === "deny" ? auto : null;

const operator = document.querySelector<HTMLFormElement>("#operator");
const promptInput = document.querySelector<HTMLInputElement>("#prompt");
const startButton = document.querySelector<HTMLButtonElement>("#start");
if (token !== null && operator !== null) operator.hidden = false;

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

/** The prompt box is the page's way to begin a run, and it lands on the server's one run path. */
operator?.addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = promptInput?.value.trim() ?? "";
  if (prompt.length === 0) return;
  socket?.send(JSON.stringify({ type: "start", prompt }));
  if (startButton !== null) startButton.disabled = true;
});

function connect(): void {
  const carry = new URLSearchParams();
  for (const key of ["drop_at", "echo_last", "auto", "hold_before"]) {
    const value = params.get(key);
    if (value !== null) carry.set(key, value);
  }
  if (token !== null) carry.set("token", token);
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
    if (startButton !== null && (handle.state().done || handle.state().failed !== null)) {
      startButton.disabled = false;
    }
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
