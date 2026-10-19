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
import {
  mountWorkspace,
  WORKSPACE_VIEWS,
  type WorkspaceView,
} from "../../../packages/ui/browser/workspace.ts";
import { latestCommand, latestRun, liveRunStatus } from "../../../packages/ui/src/aside.ts";
import { liveBotStatus } from "../../../packages/ui/src/bots.ts";
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
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt");
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
  /**
   * The stop is the contract's own `cancel_run`, not a bespoke control frame. The fixture peer has
   * no route client, so there the same message travels on the page's socket to the same authority.
   */
  onCancel: (runId) => {
    if (api !== null) {
      void api
        .cancel_run({ runId })
        .catch((error: unknown) =>
          handle.showError(error instanceof Error ? error.message : String(error)),
        );
      return;
    }
    post({ type: "cancel", runId });
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
    arrangeBot: async (patch) => {
      const { botId, ...rest } = patch;
      return await client().arrange_bot({ botId, ...rest });
    },
  },
  onRecords: () => {
    paintGroupbar();
  },
  onChange: (next) => {
    const previousBot = selection.botId;
    selection = next;
    if (previousBot !== null && previousBot !== next.botId) {
      shell.setLiveStatus(previousBot, null);
    }
    if (token !== null && next.threadId !== null) {
      void library.refresh().catch(() => undefined);
      connect();
      flushQueued();
    }
    // A different thread is a different latest run, which is what the notice stack reads.
    paintNotices();
    paintGroupbar();
    if (workspace.current() !== null) {
      workspace.hide();
      void library.show("conversation");
    }
    if (next.botId !== null) shell.setLiveStatus(next.botId, liveBotStatus(handle.state()));
  },
});
exposeShellFacts(shell);

/** A short-lived line under the page, the export's toast (`freebot-prototype.html:495-501`). */
function toast(message: string): void {
  for (const node of document.querySelectorAll(".toast")) node.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2500);
}

/**
 * The group's header: the members and which of them holds the turn. A group is a Bot record whose
 * `group` flag is set; its members are other Bot ids. This build does not run a turn per member yet,
 * so each row reports the member's own derived status and the shared volume is named as the export
 * names it.
 */
function paintGroupbar(): void {
  const bar = document.querySelector<HTMLElement>("#groupbar");
  if (bar === null) return;
  const { bot } = shell.records();
  if (bot === null || !bot.group) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const bots = shell.lists().bots;
  const head = document.createElement("span");
  head.className = "cap";
  head.textContent = "Members";
  const nodes: Node[] = [head];
  if (bot.members.length === 0) {
    const empty = document.createElement("span");
    empty.className = "hint";
    empty.textContent = "No members yet.";
    nodes.push(empty);
  }
  for (const memberId of bot.members) {
    const member = bots.find((candidate) => candidate.botId === memberId);
    if (member === undefined) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "gm";
    const dot = document.createElement("span");
    dot.className = "dot";
    chip.append(dot, document.createTextNode(member.name));
    const state = document.createElement("span");
    state.className = "s";
    state.textContent = "waiting";
    chip.append(state);
    chip.addEventListener("click", () => void shell.selectBot(member.botId));
    nodes.push(chip);
  }
  const volume = document.createElement("span");
  volume.className = "tag";
  volume.textContent = "/shared volume";
  nodes.push(volume);
  bar.replaceChildren(...nodes);
  bar.hidden = false;
}

function workspaceRecords() {
  return {
    bots: shell.lists().bots,
    selectedBot: shell.records().bot,
    threads: shell.lists().threads,
    provider: providerRecord,
    runs: shell.runs(),
  };
}

const workspace = mountWorkspace({
  read: workspaceRecords,
  calls: {
    listConnectors: async () => {
      if (api === null) return [];
      return (await api.list_connectors({})).connectors;
    },
  },
  onOpenProvider: () => providerPage.show(),
  onSelectBot: async (botId) => {
    workspace.hide();
    await shell.selectBot(botId);
  },
  onLeave: () => {
    workspace.hide();
    void library.show("conversation");
  },
});

/** Open a Workspace page, and put the conversation chrome down while it is on screen. */
function openWorkspace(view: WorkspaceView): void {
  showOperator(false);
  void workspace.show(view);
  if (view === "apps" && api !== null) {
    void api
      .list_connectors({})
      .then(({ connectors }) => {
        const count = document.querySelector<HTMLElement>("#connect-apps-count");
        if (count !== null) {
          const on = connectors.filter((connector) => connector.state === "connected").length;
          count.textContent = `${on} on`;
        }
      })
      .catch(() => undefined);
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("#nav-list [data-view]")) {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view !== undefined && (WORKSPACE_VIEWS as readonly string[]).includes(view)) {
      openWorkspace(view as WorkspaceView);
    }
  });
}

/** Leaving a page for either conversation tab is the same move as the page's own Back. */
for (const id of ["#tab-conversation", "#tab-library"]) {
  document.querySelector<HTMLButtonElement>(id)?.addEventListener("click", () => {
    workspace.hide();
  });
}

document.querySelector<HTMLButtonElement>("#computer-open")?.addEventListener("click", () => {
  if (aside.collapsed()) aside.toggle();
  void aside.show("computer");
});
document.querySelector<HTMLButtonElement>("#bot-name-button")?.addEventListener("click", () => {
  if (aside.collapsed()) aside.toggle();
  void aside.show("details");
});
document.querySelector<HTMLButtonElement>("#share-button")?.addEventListener("click", () => {
  // The operator token is installation-wide authority. A conversation link carries the path, never
  // the fragment, so pasting it elsewhere cannot hand over the API.
  void navigator.clipboard
    ?.writeText(`${location.origin}${location.pathname}`)
    .then(() => toast("Link copied without the operator token."))
    .catch(() => toast("This browser did not allow the copy."));
});
document.querySelector<HTMLButtonElement>("#connect-apps")?.addEventListener("click", () => {
  openWorkspace("apps");
});
document.querySelector<HTMLButtonElement>("#account-row")?.addEventListener("click", (event) => {
  document.querySelector(".menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu";
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
  menu.style.top = `${Math.max(8, rect.top - 8)}px`;
  for (const [label, run] of [
    ["Settings", () => openWorkspace("settings")],
    ["Provider", () => providerPage.show()],
    ["Sign out of this page", () => location.replace(`${location.origin}${location.pathname}`)],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      menu.remove();
      run();
    });
    menu.append(button);
  }
  document.body.append(menu);
  setTimeout(() => {
    const close = (click: MouseEvent): void => {
      if (menu.contains(click.target as Node)) return;
      menu.remove();
      document.removeEventListener("mousedown", close, true);
    };
    document.addEventListener("mousedown", close, true);
  }, 0);
});

/** Start a group chat: a Bot record with `group` set and the selected Bots as its members. */
function openGroupDialog(): void {
  if (api === null) {
    toast("A group chat needs the operator token.");
    return;
  }
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Start a group chat");
  const close = (): void => {
    scrim.remove();
    modal.remove();
  };
  scrim.addEventListener("click", close);

  const head = document.createElement("div");
  head.className = "modal-head";
  const title = document.createElement("h3");
  title.textContent = "Start a group chat";
  head.append(title);

  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = "Room name";
  const nameInput = document.createElement("input");
  nameInput.className = "input";
  nameInput.value = "Launch room";
  nameInput.autocomplete = "off";
  field.append(label, nameInput);

  const membersLabel = document.createElement("span");
  membersLabel.className = "cap";
  membersLabel.style.marginTop = "16px";
  membersLabel.textContent = "Members";
  const members = document.createElement("div");
  members.className = "stack";
  const candidates = shell.lists().bots.filter((bot) => !bot.group);
  if (candidates.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Make another Bot first. A group needs at least one member.";
    members.append(hint);
  }
  for (const bot of candidates) {
    const row = document.createElement("label");
    row.className = "row";
    row.style.padding = "7px 0";
    row.style.cursor = "pointer";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = bot.botId;
    const copy = document.createElement("span");
    copy.textContent = bot.name;
    const role = document.createElement("span");
    role.className = "hint";
    role.textContent = bot.role;
    role.style.marginLeft = "8px";
    copy.append(role);
    row.append(box, copy);
    members.append(row);
  }

  const foot = document.createElement("div");
  foot.className = "row";
  foot.style.justifyContent = "flex-end";
  foot.style.marginTop = "18px";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-ghost btn-sm";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  const create = document.createElement("button");
  create.type = "button";
  create.className = "btn btn-primary btn-sm";
  create.textContent = "Create the room";
  create.addEventListener("click", () => {
    const name = nameInput.value.trim();
    const chosen = [
      ...members.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked"),
    ].map((box) => box.value);
    if (name === "" || chosen.length === 0) {
      toast("A room needs a name and at least one member.");
      return;
    }
    create.disabled = true;
    void (async () => {
      try {
        const bot = await client().create_bot({ name });
        await client().arrange_bot({ botId: bot.botId, group: true, members: chosen });
        await client().create_thread({ botId: bot.botId });
        await shell.refresh();
        await shell.selectBot(bot.botId);
        close();
        toast(`${name} created with ${chosen.length} members.`);
      } catch (error) {
        create.disabled = false;
        toast(error instanceof Error ? error.message : String(error));
      }
    })();
  });
  foot.append(cancel, create);

  modal.append(head, field, membersLabel, members, foot);
  document.body.append(scrim, modal);
  nameInput.focus();
  nameInput.select();
}

document
  .querySelector<HTMLButtonElement>("#sidebar-new-group")
  ?.addEventListener("click", openGroupDialog);

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

/** Clear the box and put its height back, the way the export's send does. */
function clearPrompt(): void {
  if (promptInput === null) return;
  promptInput.value = "";
  promptInput.style.height = "auto";
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
    clearPrompt();
    return;
  }
  if (selection.threadId === null) {
    queued = prompt;
    clearPrompt();
    return;
  }
  sendStart(prompt);
  clearPrompt();
});

/** Enter sends; Shift+Enter keeps the newline the export's hint promises. */
promptInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    operator?.requestSubmit();
  }
});

promptInput?.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(180, promptInput.scrollHeight)}px`;
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
    // The Bot row follows the run's own state between record reads: a park needs a person, a run in
    // flight is work, and the ending frame is the ending.
    if (selection.botId !== null) {
      shell.setLiveStatus(selection.botId, liveBotStatus(handle.state()));
    }
    if (handle.state().error !== null) ws.close();
    if (
      message.type === "run.finished" ||
      message.type === "run.failed" ||
      (message.type === "run.status" && message.payload.status === "cancelled")
    ) {
      // The thread's own counts and its run record both moved, so the list is re-read and the two
      // surfaces that read it — the pane and the notice stack — repaint from what came back. A
      // cancelled run carries only `run.status`, so it is named here rather than left behind. The
      // live override is cleared once the record has landed, so the row's dot is derived from the
      // run store rather than from the stream that reported it.
      const endedBot = selection.botId;
      void shell
        .refresh()
        .then(() => {
          if (endedBot !== null) shell.setLiveStatus(endedBot, null);
          paintAside();
          paintNotices();
        })
        .catch(() => undefined);
    }
    if (
      startButton !== null &&
      (handle.state().done || handle.state().failed !== null || handle.state().cancelled)
    ) {
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
  const model = document.querySelector<HTMLElement>("#composer-model");
  if (model !== null) model.textContent = record?.model ?? "replay";
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
  paintGroupbar();
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
