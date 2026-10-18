/**
 * The apps/web host: read the Bots, hand every message of the selected thread to the shared thread
 * model, and let it render. The Library tab is the same host's second view of the selected Bot: it
 * reads that Bot's workspace through the oRPC route surface, with the operator token the page was
 * opened with. Everything else (the three models, the DOM contract) lives in `@freebot/ui`.
 *
 * Two peers, one page. The fixture server (`apps/web/scripts/server.ts`) is the dev peer: no token,
 * one committed replay, no Bot list. The real server serves this page and its stream, and its stream
 * is gated by the operator token, so the page presents the token it was opened with. The token rides
 * in the URL fragment, because a browser never sends a fragment to a server; only the WebSocket's
 * query string carries it, which is the one place the gate reads a token from a query.
 *
 * Operator mode is "the page was opened with a token". That is what reveals the sidebar and the
 * prompt box, because both need the Bot list; the fixture page renders exactly the page it rendered
 * before this unit. Operator mode also creates the first Bot, named `Local Bot`, on a server that
 * holds none: a person who runs `bun run up` gets a conversation to type into, and the record the
 * page makes is the same record a Bot made from the sidebar would be.
 *
 * One thread at a time. The page follows the selected thread's own log, so switching threads closes
 * the socket and opens the stream for the thread that is now on screen, replaying it from 0. The
 * last_seq it carries on a reconnect is that thread's, which is why the cursor belongs to the
 * socket and not to the page.
 *
 * A socket that is still opening is not a socket that can be sent on. Switching threads replaces
 * the socket, so anything composed in that window (a prompt, an approval answer) waits in the
 * outbox and goes out on open rather than throwing away the click that asked for it.
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type {
  apiContract,
  Message,
  ProviderConnection,
} from "../../../packages/protocol/src/index.ts";
import { exposeLibraryFacts, mountLibrary } from "../../../packages/ui/browser/library.ts";
import { exposeProviderFacts, mountProvider } from "../../../packages/ui/browser/provider.ts";
import { type Connection, exposeFacts, mountThread } from "../../../packages/ui/browser/render.ts";
import {
  exposeShellFacts,
  mountShell,
  type ShellSelection,
} from "../../../packages/ui/browser/shell.ts";
import { providerRowLabel } from "../../../packages/ui/src/provider.ts";

type ApiClient = ContractRouterClient<typeof apiContract>;

/** The name the page gives the first Bot on a server that holds none. */
const FIRST_BOT_NAME = "Local Bot";

const params = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const token = fragment.get("token") ?? params.get("token");
const auto = params.get("auto");
const autoAnswer = auto === "allow" || auto === "deny" ? auto : null;

const operator = document.querySelector<HTMLFormElement>("#operator");
const promptInput = document.querySelector<HTMLInputElement>("#prompt");
const startButton = document.querySelector<HTMLButtonElement>("#start");
const sidebar = document.querySelector<HTMLElement>("#sidebar");
const shellEl = document.querySelector<HTMLElement>(".shell");
const providerOpen = document.querySelector<HTMLButtonElement>("#provider-open");

let socket: WebSocket | null = null;
/** The Bot and thread on screen. A run and a stream both name them. */
let selection: ShellSelection = { botId: null, threadId: null };
/** The thread the transcript currently holds, so a reconnect does not clear it. */
let shownThread: string | null = null;
/** A prompt typed before the page had a thread to send it to. */
let queued: string | null = null;
/** Bumped per connection, so a socket that has been replaced cannot speak for the page. */
let generation = 0;
/** Control frames written before the socket finished opening, in the order they were asked for. */
const outbox: string[] = [];

/** The page's own reads, over the same routes a client uses, with its operator token. */
const api: ApiClient | null =
  token === null
    ? null
    : createORPCClient<ApiClient>(
        new RPCLink({
          url: `${location.origin}/rpc`,
          headers: { authorization: `Bearer ${token}` },
        }),
      );

/** Send a control frame, or hold it until the socket that will carry it is open. */
function post(payload: unknown): void {
  const frame = JSON.stringify(payload);
  const ws = socket;
  if (ws === null || ws.readyState !== WebSocket.OPEN) {
    outbox.push(frame);
    return;
  }
  ws.send(frame);
}

/** The token the shell needs. A page without one renders no Bot list at all. */
function client(): ApiClient {
  if (api === null) throw new Error("the Bot list needs the operator token");
  return api;
}

const library = mountLibrary({
  calls: {
    list: async (path) => {
      if (api === null || selection.botId === null) {
        throw new Error("the Library needs the operator token");
      }
      return await api.list_files({ botId: selection.botId, path });
    },
    read: async (path) => {
      if (api === null || selection.botId === null) {
        throw new Error("the Library needs the operator token");
      }
      return await api.read_file({ botId: selection.botId, path });
    },
  },
  onTab: (tab) => showOperator(tab === "conversation"),
});
exposeLibraryFacts(library);

/** The prompt box is operator mode on the conversation tab, and nothing else. */
function showOperator(visible: boolean): void {
  if (operator !== null) operator.hidden = token === null || !visible;
}
showOperator(true);

const handle = mountThread({
  autoAnswer,
  onAnswer: (decision, approvalId) => {
    post({ type: "answer", decision, approvalId });
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
  post(message);
};

const shell = mountShell({
  calls: {
    listBots: async () => (await client().list_bots({})).bots,
    createBot: (name) => client().create_bot({ name }),
    listThreads: async (botId) => (await client().list_threads({ botId })).threads,
    createThread: async (botId, title) =>
      await client().create_thread(title === undefined ? { botId } : { botId, title }),
  },
  onChange: (next) => {
    selection = next;
    if (token !== null && next.threadId !== null) {
      void library.refresh().catch(() => undefined);
      connect();
      flushQueued();
    }
  },
});
exposeShellFacts(shell);

/** Start the run the composer asked for, in the Bot and the thread on screen. */
function sendStart(prompt: string): void {
  post({ type: "start", prompt, botId: selection.botId, threadId: selection.threadId });
  if (startButton !== null) startButton.disabled = true;
}

/** Send a prompt that arrived before the page had a thread to send it to. */
function flushQueued(): void {
  if (queued === null || selection.threadId === null) return;
  const prompt = queued;
  queued = null;
  sendStart(prompt);
}

/** The prompt box is the page's way to begin a run, and it lands on the server's one run path. */
operator?.addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = promptInput?.value.trim() ?? "";
  if (prompt.length === 0) return;
  if (token === null) {
    // The dev peer holds one committed thread and no Bot list, so it takes the bare message.
    post({ type: "start", prompt });
    if (startButton !== null) startButton.disabled = true;
    return;
  }
  if (selection.threadId === null) {
    queued = prompt;
    return;
  }
  sendStart(prompt);
});

/** Follow the selected thread's log, from where this thread's display left off. */
function connect(): void {
  const threadId = selection.threadId;
  const mine = ++generation;
  const threadChanged = threadId !== shownThread;
  if (threadId !== null && threadChanged) {
    // A different conversation: the transcript on screen belongs to the thread that was selected.
    handle.reset();
    shownThread = threadId;
    if (startButton !== null) startButton.disabled = false;
  }
  if (token !== null && threadId === null) return;

  // A fresh socket, and the page says so until it opens: the previous socket's state is not this
  // one's, and a send that arrives before it opens belongs in the outbox.
  handle.setConnection("connecting");
  const carry = new URLSearchParams();
  for (const key of ["drop_at", "echo_last", "auto", "hold_before"]) {
    const value = params.get(key);
    if (value !== null) carry.set(key, value);
  }
  if (token !== null) carry.set("token", token);
  if (threadId !== null) carry.set("thread_id", threadId);
  carry.set("last_seen_seq", String(handle.state().lastSeq));
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  // The socket this one replaces is still open until it is closed here. It stops being the page's
  // socket on the line below, and its handlers are the previous generation's, so it is inert from
  // this point on; leaving it open would leak a subscription on the server for every thread switch.
  socket?.close();
  const ws = new WebSocket(`${scheme}://${location.host}/events?${carry.toString()}`);
  socket = ws;

  ws.onopen = () => {
    if (mine !== generation) return;
    handle.setConnection("connected");
    for (const frame of outbox.splice(0)) ws.send(frame);
  };
  ws.onmessage = (event) => {
    if (mine !== generation) return;
    const message = JSON.parse(String(event.data)) as Message;
    try {
      handle.apply(message);
    } catch (err) {
      handle.showError(err instanceof Error ? err.message : String(err));
      ws.close();
      return;
    }
    if (handle.state().error !== null) ws.close();
    if (message.type === "run.finished" || message.type === "run.failed") {
      // The thread's own counts moved, so the list that shows them is re-read.
      void shell.refresh().catch(() => undefined);
    }
    if (startButton !== null && (handle.state().done || handle.state().failed !== null)) {
      startButton.disabled = false;
    }
  };
  ws.onclose = () => {
    if (mine !== generation) return;
    if (handle.state().error !== null) return;
    handle.setConnection("reconnecting");
    setTimeout(connect, 250);
  };
  ws.onerror = () => {
    if (mine !== generation) return;
    if (handle.state().error !== null) return;
    handle.setConnection("reconnecting");
  };
}

const initial: Connection = "connecting";
handle.setConnection(initial);

/**
 * The sidebar footer's provider row: the active connection at a glance, and the way back to page 1.
 * A FreeBot install can hold one active connection, so the row is the whole of that surface.
 */
function paintProviderButton(connection: ProviderConnection | null): void {
  if (providerOpen === null) return;
  providerOpen.textContent = providerRowLabel(connection);
  providerOpen.dataset.providerStatus = connection?.status ?? "none";
}

/** The conversation: the Bot list, the selected thread, and the stream over it. */
async function enterApp(): Promise<void> {
  providerPage.hide();
  if (sidebar !== null) sidebar.hidden = false;
  if (shellEl !== null) shellEl.dataset.operator = "true";
  await shell.load();
  if (shell.facts().bots.length === 0) {
    // The first time a server with a connection runs there is no Bot, and a conversation needs one.
    await shell.createBot(FIRST_BOT_NAME);
  } else {
    selection = shell.selection();
    connect();
  }
}

const providerPage = mountProvider({
  calls: {
    read: async () => {
      if (api === null) throw new Error("page 1 needs the operator token");
      return await api.get_provider({});
    },
    connect: async (input) => {
      if (api === null) throw new Error("page 1 needs the operator token");
      return await api.connect_provider(input);
    },
  },
  onSaved: (connection) => paintProviderButton(connection),
  onContinue: () =>
    void enterApp().catch((error: unknown) =>
      handle.showError(error instanceof Error ? error.message : String(error)),
    ),
  onReplay: () =>
    void enterApp().catch((error: unknown) =>
      handle.showError(error instanceof Error ? error.message : String(error)),
    ),
});
exposeProviderFacts(providerPage);
providerOpen?.addEventListener("click", () => providerPage.show());

if (token !== null && sidebar !== null && shellEl !== null) {
  void (async () => {
    try {
      const state = await providerPage.load();
      paintProviderButton(state.connection);
      if (state.connection === null) {
        // Page 1 is the first page a new person sees: the vault holds nothing to run on, so the
        // welcome page takes the center and the Bot list stays out of the way.
        providerPage.show();
        return;
      }
      await enterApp();
    } catch (error) {
      handle.showError(error instanceof Error ? error.message : String(error));
    }
  })();
}

connect();
