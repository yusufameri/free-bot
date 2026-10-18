/**
 * The details pane's DOM: the tab strip, the tab bodies, and the drag that sets the pane's width.
 *
 * It decides nothing. `packages/ui/src/aside.ts` owns the tabs, the clamps, the width default and the
 * rows each tab shows; this module turns those into nodes and reads them back for the evidence
 * harness, the same split `shell.ts` and `library.ts` keep.
 *
 * The structure is the export's (`freebot-prototype.html:1183-1197`): a `.aside-tabs` strip with
 * `role="tablist"`, one `.aside-tab` per tab carrying `role="tab"` and `aria-selected`, the strip's
 * own `.aside-close`, and one scrolling `.aside-body` under it. The pane's width is the `--aside-w`
 * the grid reads, and this module is what overwrites the declared token with the width the page is
 * really using, exactly as the export's `initResize` does at `:2248`.
 *
 * The records arrive already read: the host holds the Bot, the thread, the provider connection, the
 * stream's own counters and the Library's listing, and hands them over on `update()`. Nothing here
 * asks a server for anything, and the two things only the host can do — open page 1, open a file in
 * the Library's own view — leave through callbacks.
 */

import type { Bot, ProviderConnection, Thread } from "@freebot/protocol";
import {
  ASIDE_COLLAPSE_LABEL,
  ASIDE_REOPEN_LABEL,
  ASIDE_STORAGE_KEY,
  ASIDE_TABS,
  ASIDE_TOGGLE_TEXT,
  type AsideBlock,
  type AsideCommand,
  type AsideFacts,
  type AsideFiles,
  type AsideInput,
  type AsideLive,
  type AsideRun,
  type AsideTab,
  asideBlocks,
  asideWidthFromPointer,
  readAsideStored,
  stampOf,
} from "../src/aside.ts";
import { humanSize, LIBRARY_PINNED_LABEL, LIBRARY_PINNED_PATH } from "../src/library.ts";
import { icon } from "./icons.ts";

/** Everything the pane shows, read by the host from the records it already holds. */
export interface AsideRecords {
  readonly bot: Bot | null;
  readonly thread: Thread | null;
  readonly connection: ProviderConnection | null;
  readonly live: AsideLive;
  readonly files: AsideFiles;
}

export interface AsideHandle {
  /** Push the records. The pane repaints; it keeps no copy of them. */
  update(records: AsideRecords): void;
  /** Select a tab, as a click on the strip does. */
  show(tab: AsideTab): Promise<void>;
  /** Collapse or expand, as the header control and the strip's own button both do. */
  toggle(): void;
  collapsed(): boolean;
  facts(): AsideFacts;
}

declare global {
  interface Window {
    /** Live pane facts, read from the DOM, for the CDP harness. */
    __asideFacts?: () => AsideFacts;
  }
}

function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element ${selector}`);
  return found;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

/** One `.kv` row: the label the record names, and the value it holds. */
function kvRow(label: string, value: string): HTMLElement {
  const row = el("div", "kv");
  row.append(el("span", "k", label));
  row.append(el("span", "v", value));
  return row;
}

/** The monochrome state dot the export's cards open with: pulsing while a call is still moving. */
function dotFor(status: string): HTMLSpanElement {
  const moving = status === "running" || status === "requested" || status === "awaiting approval";
  return el("span", moving ? "pulse" : "dot on");
}

export function mountAside(config: {
  readonly now?: () => number;
  /** Fired after the tab changes, so the host can load what that tab reads. */
  readonly onTab?: (tab: AsideTab) => Promise<void> | void;
  /** Fired when a reader opens a row that only the host can show: the Library's own file view. */
  readonly onOpenFile?: (path: string) => void;
}): AsideHandle {
  const now = config.now ?? Date.now;
  const asideEl = must<HTMLElement>("#aside");
  const resizerEl = must<HTMLElement>("#resizer");
  const toggleEl = must<HTMLButtonElement>("#aside-toggle");

  const stored = readAsideStored(localStorage.getItem(ASIDE_STORAGE_KEY));
  let tab: AsideTab = stored.tab;
  let collapsed = stored.collapsed;
  let width = stored.width;
  let dragging = false;
  let records: AsideRecords | null = null;

  const strip = el("div", "aside-tabs");
  strip.setAttribute("role", "tablist");
  const bodyEl = el("div", "aside-body");
  bodyEl.id = "asideBody";
  const tabButtons = new Map<AsideTab, HTMLButtonElement>();
  for (const entry of ASIDE_TABS) {
    const button = el("button", "aside-tab", entry.label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.dataset.tab = entry.id;
    button.addEventListener("click", () => void handle.show(entry.id));
    tabButtons.set(entry.id, button);
  }
  const closeButton = el("button", "iconbtn aside-close");
  closeButton.type = "button";
  closeButton.append(icon("x"));
  closeButton.setAttribute("aria-label", ASIDE_COLLAPSE_LABEL);
  closeButton.addEventListener("click", () => handle.toggle());
  strip.append(...tabButtons.values(), closeButton);
  asideEl.replaceChildren(strip, bodyEl);

  function persist(): void {
    localStorage.setItem(ASIDE_STORAGE_KEY, JSON.stringify({ width, collapsed, tab }));
  }

  /** The width the grid reads and the width the evidence reads. One write, both readers. */
  function paintWidth(): void {
    document.documentElement.style.setProperty("--aside-w", `${width}px`);
    asideEl.dataset.width = String(width);
  }

  function paintCollapsed(): void {
    document.body.classList.toggle("collapsed", collapsed);
    asideEl.dataset.collapsed = String(collapsed);
    toggleEl.textContent = ASIDE_TOGGLE_TEXT;
    toggleEl.setAttribute("aria-pressed", String(!collapsed));
    toggleEl.setAttribute("aria-label", collapsed ? ASIDE_REOPEN_LABEL : ASIDE_COLLAPSE_LABEL);
  }

  function paintTabs(): void {
    for (const [id, button] of tabButtons) {
      const active = id === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  function commandCard(command: AsideCommand): HTMLElement {
    const card = el("div", "tcard");
    const head = el("div", "tcard-head");
    head.append(dotFor(command.status));
    head.append(el("span", "ttl truncate", command.toolName));
    head.append(el("span", "tag", command.status));
    const body = el("div", "tcard-body");
    body.append(el("code", "cmd", command.command));
    if (command.decision !== null) body.append(kvRow("Decision", command.decision));
    if (command.output !== null && command.output !== "") {
      body.append(el("pre", "output", command.output));
    }
    card.append(head, body);
    return card;
  }

  function runCard(run: AsideRun, live: boolean): HTMLElement {
    const card = el("div", "tcard");
    card.dataset.run = run.runId;
    card.dataset.live = String(live);
    const head = el("div", "tcard-head");
    head.append(dotFor(live ? "running" : run.status));
    head.append(el("span", "ttl truncate", run.prompt === "" ? run.runId : run.prompt));
    head.append(el("span", "tag", run.status));
    const body = el("div", "tcard-body");
    body.append(kvRow("Run", run.runId));
    body.append(kvRow("Started", stampOf(run.startedAt, now())));
    card.append(head, body);
    return card;
  }

  function fileNodes(block: Extract<AsideBlock, { kind: "files" }>): Node[] {
    const nodes: Node[] = [];
    const pathRow = el("div", "aside-path");
    pathRow.dataset.path = block.path;
    pathRow.append(el("span", "mono fs-meta", block.pinned ? LIBRARY_PINNED_LABEL : block.path));
    if (block.pinned) pathRow.append(el("span", "tag", "pinned"));
    nodes.push(pathRow);
    for (const group of block.groups) {
      nodes.push(el("span", "cap", group.group));
      for (const entry of group.entries) {
        const row = el("button", "aside-file");
        row.type = "button";
        row.dataset.path = entry.path;
        row.dataset.name = entry.name;
        row.dataset.kind = entry.kind;
        row.append(el("span", "aside-file-name truncate", entry.name));
        row.append(el("span", "aside-file-path truncate", entry.path));
        if (entry.kind === "file") row.append(el("span", "aside-file-size", humanSize(entry.size)));
        row.addEventListener("click", () => config.onOpenFile?.(entry.path));
        nodes.push(row);
      }
    }
    return nodes;
  }

  function blockNodes(block: AsideBlock): Node[] {
    switch (block.kind) {
      case "cap":
        return [el("span", "cap", block.text)];
      case "rows":
        return block.rows.map((row) => kvRow(row.label, row.value));
      case "note":
        return [el("p", "hint", block.text)];
      case "command":
        return [commandCard(block.command)];
      case "run":
        return [runCard(block.run, block.live)];
      case "files":
        return fileNodes(block);
    }
  }

  function paint(): void {
    const live: AsideLive = records?.live ?? {
      connection: "connecting",
      runId: null,
      runStatus: null,
      lastSeq: 0,
      frames: 0,
      command: null,
    };
    const files: AsideFiles = records?.files ?? {
      path: LIBRARY_PINNED_PATH,
      entries: [],
      state: "idle",
      refusal: null,
    };
    const input: AsideInput = {
      bot: records?.bot ?? null,
      thread: records?.thread ?? null,
      connection: records?.connection ?? null,
      live,
      files,
      now: now(),
    };
    bodyEl.replaceChildren(...asideBlocks(tab, input).flatMap(blockNodes));
  }

  const handle: AsideHandle = {
    update(next) {
      records = next;
      paint();
    },

    async show(next) {
      tab = next;
      paintTabs();
      persist();
      await config.onTab?.(next);
      paint();
    },

    toggle() {
      collapsed = !collapsed;
      paintCollapsed();
      persist();
    },

    collapsed: () => document.body.classList.contains("collapsed"),

    facts() {
      const root = document.documentElement;
      const used = Math.round(
        Number.parseFloat(getComputedStyle(root).getPropertyValue("--aside-w")),
      );
      const saved = readAsideStored(localStorage.getItem(ASIDE_STORAGE_KEY));
      const text = (selector: string): string[] =>
        [...asideEl.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent ?? "");
      return {
        tab,
        tabs: [...tabButtons.entries()].map(([id, button]) => ({
          id,
          label: button.textContent ?? "",
          selected: button.classList.contains("is-active"),
          ariaSelected: button.getAttribute("aria-selected") ?? "",
        })),
        collapsed: document.body.classList.contains("collapsed"),
        width: Number.isFinite(used) ? used : width,
        storedWidth: saved.width,
        storedTab: saved.tab,
        bodyText: bodyEl.textContent ?? "",
        caps: text(".cap"),
        rows: [...asideEl.querySelectorAll<HTMLElement>(".kv")].map((row) => ({
          label: row.querySelector(".k")?.textContent ?? "",
          value: row.querySelector(".v")?.textContent ?? "",
        })),
        commands: text(".cmd"),
        files: [...asideEl.querySelectorAll<HTMLElement>(".aside-file")].map((node) => ({
          name: node.dataset.name ?? "",
          path: node.dataset.path ?? "",
          kind: node.dataset.kind ?? "",
        })),
        notes: text(".hint"),
      };
    },
  };

  function endDrag(): void {
    dragging = false;
    document.body.style.userSelect = "";
    persist();
  }

  resizerEl.addEventListener("pointerdown", (event) => {
    dragging = true;
    resizerEl.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
  });
  resizerEl.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    width = asideWidthFromPointer(window.innerWidth, event.clientX);
    paintWidth();
  });
  resizerEl.addEventListener("pointerup", (event) => {
    try {
      resizerEl.releasePointerCapture(event.pointerId);
    } catch {
      // The capture is already gone; the drag is over either way.
    }
    endDrag();
  });
  resizerEl.addEventListener("pointercancel", () => endDrag());
  toggleEl.addEventListener("click", () => handle.toggle());

  paintWidth();
  paintCollapsed();
  paintTabs();
  paint();

  return handle;
}

/** Expose the live pane facts on `window`, so a CDP driver reads the page. */
export function exposeAsideFacts(handle: AsideHandle): void {
  window.__asideFacts = () => handle.facts();
}
