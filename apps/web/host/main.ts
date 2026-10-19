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
 * Three screens. A store with no Bot is a fresh install, and the first-run screen takes the page: it
 * asks for a name, a purpose and a starting job, and it may test the model connection on the way
 * through. Page 1 (U4.3's welcome, then connect a provider) is what a keyless machine with a Bot
 * boots into, and the sidebar footer's provider row opens it afterwards. The shell is the third: the
 * Bot list, the selected thread, and the stream over it.
 *
 * A Bot exists because a person named one. The first-run screen makes it on the name pane's
 * Continue, through the same `create_bot` and `create_thread` arms the sidebar's own control uses,
 * so `Local Bot` survives only as the Skip path's answer on a store that still holds nothing.
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
import {
  type AsideRecords,
  exposeAsideFacts,
  mountAside,
} from "../../../packages/ui/browser/aside.ts";
import {
  exposeFirstRunFacts,
  type FirstRunOutcome,
  mountFirstRun,
} from "../../../packages/ui/browser/first-run.ts";
import { exposeLibraryFacts, mountLibrary } from "../../../packages/ui/browser/library.ts";
import { exposeNoticeFacts, mountNotices } from "../../../packages/ui/browser/notices.ts";
import { exposeOverlayFacts, mountOverlays } from "../../../packages/ui/browser/overlays.ts";
import { exposeProviderFacts, mountProvider } from "../../../packages/ui/browser/provider.ts";
import { type Connection, exposeFacts, mountThread } from "../../../packages/ui/browser/render.ts";
import {
  exposeShellFacts,
  mountShell,
  type ShellSelection,
} from "../../../packages/ui/browser/shell.ts";
import { latestCommand, latestRun, liveRunStatus } from "../../../packages/ui/src/aside.ts";
import type { OverlayCommand } from "../../../packages/ui/src/overlays.ts";
import { providerRowLabel } from "../../../packages/ui/src/provider.ts";

type ApiClient = ContractRouterClient<typeof apiContract>;

/** The name the Skip path gives the first Bot on a server that still holds none, as it always did. */
const SKIP_BOT_NAME = "Local Bot";

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
/** The page's own socket state, which the header word, the banner and the pane all read. */
let connection: Connection = "connecting";
/** The provider record the page last read or tested, for page 1's row, the pane and the notices. */
let providerRecord: ProviderConnection | null = null;
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
  // The pane's Library tab renders the same listing this surface holds, so a change here is a change
  // there: one read, two views of it.
  onChange: () => paintAside(),
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
  // One reporter for the page's socket state: the header word, the banner and the pane all follow it.
  onConnection: (next) => {
    connection = next;
    notices.setConnection(next);
    paintAside();
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
    // A different thread is a different latest run, which is what the notice stack reads.
    paintNotices();
  },
});
exposeShellFacts(shell);

/**
 * The details pane, rebuilt from the records the page already holds: the shell's selection, the
 * provider record page 1 read, the stream's own counters and the Library's listing. Every row the
 * pane shows comes from one of those, and `packages/ui/src/aside.ts` is what decides the words.
 */
function paintAside(): void {
  const { bot, thread } = shell.records();
  const state = handle.state();
  const records: AsideRecords = {
    bot,
    thread,
    connection: providerRecord,
    live: {
      connection,
      runId: state.runId,
      runStatus: liveRunStatus(state),
      lastSeq: state.lastSeq,
      frames: state.applied,
      command: latestCommand(state),
    },
    files: library.listing(),
  };
  aside.update(records);
}

/** The notice stack, from the two records that raise one: the provider connection and the run. */
function paintNotices(): void {
  notices.update({ connection: providerRecord, latest: latestRun(shell.records().thread) });
}

const aside = mountAside({
  onTab: async (tab) => {
    // The Library tab reads the workspace through the surface the Library itself uses, so the two
    // views are one listing rather than two reads.
    if (tab === "library") await library.refresh();
  },
  onOpenFile: (path) => {
    // A row opens the export's own wide modal (`freebot-prototype.html:1831`), read through the same
    // call the Library surface reads with, so the two views of one file cannot disagree.
    void overlays.openFile(path).catch(() => undefined);
  },
});

const notices = mountNotices({ onOpenProvider: () => providerPage.show() });
exposeAsideFacts(aside);
exposeNoticeFacts(notices);

/**
 * The three overlays. Every command they carry runs the same call its own button makes, so a row in
 * the palette and the control it names land on one path: `select-bot` is a sidebar row, `new-thread`
 * is `#new-thread`, `show-library` is the Library tab, `open-provider` is the footer's row. The
 * modal's bytes are read through the Library's own call, so the pane and the Library surface render
 * one read rather than two that can disagree.
 */
async function runOverlayCommand(command: OverlayCommand): Promise<void> {
  switch (command.run) {
    case "select-bot":
      await shell.selectBot(command.botId);
      return;
    case "create-bot":
      await shell.createBot(command.name);
      return;
    case "select-thread":
      await shell.selectThread(command.threadId);
      return;
    case "show-conversation":
      await library.show("conversation");
      return;
    case "show-library":
      await library.show("library");
      return;
    case "open-provider":
      providerPage.show();
      return;
    case "new-thread":
      await shell.createThread();
      return;
  }
}

const overlays = mountOverlays({
  records: () => ({ operator: shell.facts().operator, ...shell.lists() }),
  readFile: async (path) => {
    if (api === null || selection.botId === null) {
      throw new Error("the file view needs the operator token");
    }
    return await api.read_file({ botId: selection.botId, path });
  },
  run: runOverlayCommand,
});
exposeOverlayFacts(overlays);

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
    // The transcript moved, so the pane's own counters, its run and its newest command moved too.
    paintAside();
    if (handle.state().error !== null) ws.close();
    if (message.type === "run.finished" || message.type === "run.failed") {
      // The thread's own counts and its run record both moved, so the list is re-read and the two
      // surfaces that read it — the pane and the notice stack — repaint from what came back.
      void shell
        .refresh()
        .then(() => {
          paintAside();
          paintNotices();
        })
        .catch(() => undefined);
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
function paintProviderButton(record: ProviderConnection | null): void {
  providerRecord = record;
  if (providerOpen !== null) {
    providerOpen.textContent = providerRowLabel(record);
    providerOpen.dataset.providerStatus = record?.status ?? "none";
  }
  // The connection is what the pane's Details tab and the notice stack read, so both repaint here.
  paintNotices();
  paintAside();
}

/** The conversation: the Bot list, the selected thread, and the stream over it. */
async function enterApp(): Promise<void> {
  providerPage.hide();
  firstRun.hide();
  if (sidebar !== null) sidebar.hidden = false;
  if (shellEl !== null) shellEl.dataset.operator = "true";
  await shell.load();
  paintAside();
  if (shell.facts().bots.length === 0) {
    // Reachable only through Skip: a person who left the first-run screen without naming a Bot still
    // needs a conversation to type into, and `Local Bot` is the answer this page always gave.
    await shell.createBot(SKIP_BOT_NAME);
    return;
  }
  selection = shell.selection();
  connect();
}

/** The Bot the first-run screen made or found, so its later panes can describe it. */
function nameTheBot(name: string): Promise<string> {
  return shell.createBot(name).then(() => {
    const botId = shell.selection().botId;
    if (botId === null) throw new Error("the Bot was not made");
    return botId;
  });
}

/**
 * The first-run screen is through: the shell takes the page, and a chosen job lands in the composer
 * as its prompt. The export writes the chosen task into the box rather than starting the run
 * (`freebot-prototype.html:2240`), and the person presses the page's own Start when they are ready.
 * The focus lands after the shell has the page, because a box inside a standing-down screen cannot
 * take it.
 */
async function finishFirstRun(outcome: FirstRunOutcome): Promise<void> {
  if (outcome.task !== null && promptInput !== null) promptInput.value = outcome.task;
  await enterApp();
  // The wizard's own field still holds focus when its screen goes away, and the browser takes that
  // focus back at the next style update rather than at this call, so the composer's focus lands
  // after it.
  if (outcome.task !== null && promptInput !== null) {
    setTimeout(() => promptInput?.focus(), 0);
  }
}

const firstRun = mountFirstRun({
  calls: {
    createBot: nameTheBot,
    updateBot: async (botId, role, purpose) => {
      await client().update_bot({ botId, role, purpose });
    },
    readProvider: async () => {
      if (api === null) throw new Error("the first run needs the operator token");
      return await api.get_provider({});
    },
    connect: async (input) => {
      if (api === null) throw new Error("the first run needs the operator token");
      return await api.connect_provider(input);
    },
  },
  onSaved: (connection) => paintProviderButton(connection),
  onFinish: (outcome) =>
    void finishFirstRun(outcome).catch((error: unknown) =>
      handle.showError(error instanceof Error ? error.message : String(error)),
    ),
  onError: (message) => handle.showError(message),
});
exposeFirstRunFacts(firstRun);

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
      const bots = (await client().list_bots({})).bots;
      if (bots.length === 0) {
        // A store with no Bot is a fresh install, and the first-run screen is what it opens: it asks
        // for the name rather than naming a Bot itself. Page 1 stays behind the provider row, and it
        // is what a keyless machine with a Bot boots into.
        await firstRun.load();
        firstRun.show();
        return;
      }
      if (state.connection === null) {
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
