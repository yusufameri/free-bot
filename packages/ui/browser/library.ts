/**
 * The Library's DOM: the Bot's workspace as a list, and one file open.
 *
 * It decides nothing. `packages/ui/src/library.ts` owns the grouping, the wording and the state
 * vocabulary; this module turns those decisions into nodes and reads them back for the evidence
 * harness, the same split `render.ts` keeps for the thread.
 *
 * The two calls arrive as `calls`, already carrying the operator token, so nothing here knows what a
 * transport is. A refusal is whatever the call throws with a `code`, which is the name the server
 * put on the wire, and a refusal never renders bytes.
 */

import type { FileEntry } from "@freebot/protocol";
import {
  groupEntries,
  humanSize,
  LIBRARY_LOADING,
  LIBRARY_NOTE,
  LIBRARY_PINNED_LABEL,
  LIBRARY_PINNED_NOTE,
  LIBRARY_PINNED_PATH,
  LIBRARY_TITLE,
  type LibraryFacts,
  type LibraryGroup,
  type LibraryState,
  type LibraryTab,
  refusedLine,
  statusLine,
} from "../src/library.ts";

export interface WorkspaceListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
}

export interface WorkspaceContents {
  readonly path: string;
  readonly text: string;
  readonly size: number;
  readonly truncated: boolean;
}

/** The two reads, with the token already applied and any failure still carrying its `code`. */
export interface WorkspaceCalls {
  readonly list: (path: string) => Promise<WorkspaceListing>;
  readonly read: (path: string) => Promise<WorkspaceContents>;
}

export interface LibraryHandle {
  /** Open a tab, loading the listing when the Library is opened. */
  show(tab: LibraryTab): Promise<void>;
  /** Re-read the listing on screen. */
  refresh(): Promise<void>;
  facts(): LibraryFacts;
}

declare global {
  interface Window {
    /** Live Library facts, read from the DOM, for the CDP harness. */
    __libraryFacts?: () => LibraryFacts;
  }
}

function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element ${selector}`);
  return found;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

/** The refusal name a failed call carries, or `unknown` for a failure that names nothing. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "unknown";
}

export function mountLibrary(config: {
  readonly calls: WorkspaceCalls;
  readonly now?: () => number;
  /** Fired after the tab changes, so the host can apply what only it knows (operator mode). */
  readonly onTab?: (tab: LibraryTab) => void;
}): LibraryHandle {
  const now = config.now ?? Date.now;
  const libraryEl = must<HTMLElement>("#library");
  const noteEl = must<HTMLElement>("#library-note");
  const statusEl = must<HTMLElement>("#library-status");
  const listEl = must<HTMLElement>("#library-list");
  const viewEl = must<HTMLElement>("#library-view");
  const viewPathEl = must<HTMLElement>("#library-view-path");
  const viewTextEl = must<HTMLElement>("#library-view-text");
  const viewRefusedEl = must<HTMLElement>("#library-view-refused");
  const conversationTab = must<HTMLButtonElement>("#tab-conversation");
  const libraryTab = must<HTMLButtonElement>("#tab-library");
  const threadEl = must<HTMLElement>("#thread");

  noteEl.textContent = LIBRARY_NOTE;
  libraryTab.textContent = LIBRARY_TITLE;

  let state: LibraryState = "idle";
  let tab: LibraryTab = "conversation";
  let listPath = LIBRARY_PINNED_PATH;
  let entries: readonly FileEntry[] = [];
  let openPath: string | null = null;
  let openText: string | null = null;
  let refused: string | null = null;
  let message = "";

  function paintTabs(): void {
    for (const [button, name] of [
      [conversationTab, "conversation"],
      [libraryTab, "library"],
    ] as const) {
      const active = tab === name;
      button.dataset.active = String(active);
      button.setAttribute("aria-current", String(active));
    }
    const onLibrary = tab === "library";
    document.body.dataset.tab = tab;
    libraryEl.hidden = !onLibrary;
    threadEl.hidden = onLibrary;
  }

  /** One row per entry, under its group's heading, with the pinned workspace row above them all. */
  function paintList(): void {
    const pinned = document.createElement("button");
    pinned.id = "library-pinned";
    pinned.className = "library-pinned";
    pinned.dataset.path = LIBRARY_PINNED_PATH;
    pinned.append(document.createTextNode(LIBRARY_PINNED_LABEL));
    pinned.append(span("library-pinned-note", LIBRARY_PINNED_NOTE));
    pinned.addEventListener("click", () => void list(LIBRARY_PINNED_PATH));

    const children: Node[] = [pinned];
    for (const group of groupEntries(entries, now())) {
      const title = document.createElement("h3");
      title.className = "library-group-title";
      title.dataset.group = group.group;
      title.textContent = group.group;
      const groupList = document.createElement("ul");
      groupList.className = "library-group";
      groupList.dataset.group = group.group;
      for (const entry of group.entries) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.className = "library-entry";
        button.dataset.path = entry.path;
        button.dataset.kind = entry.kind;
        button.dataset.name = entry.name;
        button.dataset.size = String(entry.size);
        button.append(document.createTextNode(entry.name));
        if (entry.kind === "file") button.append(span("library-size", humanSize(entry.size)));
        button.addEventListener("click", () => {
          if (entry.kind === "dir") void list(entry.path);
          else void open(entry.path);
        });
        item.append(button);
        groupList.append(item);
      }
      children.push(title, groupList);
    }
    listEl.replaceChildren(...children);
  }

  function showView(path: string | null, text: string | null, refusal: string | null): void {
    viewEl.hidden = path === null;
    viewPathEl.dataset.path = path ?? "";
    viewPathEl.textContent = path ?? "";
    viewTextEl.dataset.path = path ?? "";
    viewTextEl.textContent = text ?? "";
    viewRefusedEl.hidden = refusal === null;
    viewRefusedEl.dataset.refusal = refusal ?? "";
    viewRefusedEl.textContent = refusal === null || path === null ? "" : refusedLine(path, refusal);
  }

  function setState(next: LibraryState, line: string): void {
    state = next;
    message = line;
    libraryEl.dataset.libraryState = next;
    statusEl.dataset.libraryStatus = next;
    statusEl.textContent = line;
  }

  async function list(path: string): Promise<void> {
    setState("loading", LIBRARY_LOADING);
    try {
      const listing = await config.calls.list(path);
      entries = listing.entries;
      listPath = listing.path;
      paintList();
      setState(
        listing.entries.length === 0 ? "empty" : "loaded",
        statusLine(listing.entries.length === 0 ? "empty" : "loaded", path, null),
      );
    } catch (error) {
      entries = [];
      listPath = path;
      paintList();
      setState("refused", statusLine("refused", path, codeOf(error)));
    }
  }

  async function open(path: string): Promise<void> {
    try {
      const file = await config.calls.read(path);
      openPath = file.path;
      openText = file.text;
      refused = null;
      showView(file.path, file.text, null);
    } catch (error) {
      openPath = path;
      openText = null;
      refused = codeOf(error);
      showView(path, null, refused);
    }
  }

  conversationTab.addEventListener("click", () => void handle.show("conversation"));
  libraryTab.addEventListener("click", () => void handle.show("library"));

  const handle: LibraryHandle = {
    async show(next) {
      tab = next;
      paintTabs();
      config.onTab?.(next);
      if (next === "library") await list(listPath);
    },
    async refresh() {
      await list(listPath);
    },
    facts() {
      return {
        tab,
        state,
        pinnedLabel: LIBRARY_PINNED_LABEL,
        pinnedPath: LIBRARY_PINNED_PATH,
        listPath,
        groups: [...listEl.querySelectorAll<HTMLElement>(".library-group-title")].map(
          (node) => node.textContent ?? "",
        ),
        entries: [...listEl.querySelectorAll<HTMLElement>(".library-entry")].map((node) => ({
          path: node.dataset.path ?? "",
          kind: (node.dataset.kind ?? "file") as "file" | "dir",
          name: node.dataset.name ?? "",
          size: Number(node.dataset.size ?? "0"),
          group: (node.closest<HTMLElement>(".library-group")?.dataset.group ??
            "Older") as LibraryGroup,
        })),
        openPath,
        openText,
        refused,
        message,
      };
    },
  };

  paintTabs();
  paintList();
  setState("idle", "");
  return handle;
}

/** Expose the live Library facts on `window`, so a CDP driver reads the page. */
export function exposeLibraryFacts(handle: LibraryHandle): void {
  window.__libraryFacts = () => handle.facts();
}
