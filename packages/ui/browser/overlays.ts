/**
 * The three overlays' DOM: the command palette, the Bot picker, and the modal.
 *
 * It decides nothing. `packages/ui/src/overlays.ts` owns the rows, their order, the matching rule,
 * the mark, the picker's threshold and the copy; this module turns those into nodes, keeps focus
 * where the export keeps it, and reads the result back for the evidence harness.
 *
 * The structure and the classes are the export's: `.palette` and `.picker` with their own list
 * (`freebot-prototype.html:441-493`), the modal with its `.modal-head` and its close button
 * (`:918-931`), the `.pop-item` row, and the `mark` the matched term wears. The export's own
 * screen-element ids and its annotation class names are not carried, and a panel is detached rather
 * than hidden, so no `hidden` class ships.
 *
 * One overlay is open at a time, which is the export's own model: its three openers each close the
 * other two (`:2091`, `:2110`, `:918`). The stack below is one deep for that reason, and Escape
 * pops the top of it and nothing else.
 *
 * Two behaviours are this app's own, because a keyboard needs them and the export has neither: the
 * arrows move the active row inside the list the input keeps the focus in, and Tab cycles the
 * focusables inside the open panel, so focus cannot leave an overlay while it is up. Closing hands
 * focus back to the element that opened it.
 */

import type { Bot, Thread } from "@freebot/protocol";
import {
  CREATING_LABEL,
  fileFromRead,
  fileFromRefusal,
  markLabel,
  matchPalette,
  type OverlayCommand,
  type OverlayFile,
  type OverlayId,
  PALETTE_NO_RESULTS,
  PALETTE_PLACEHOLDER,
  type PaletteMode,
  type PaletteRow,
  PICKER_PLACEHOLDER,
  paletteRows,
  pickerRows,
  refusalCode,
} from "../src/overlays.ts";
import { icon } from "./icons.ts";

/** The records the overlays read: the Bot list, the selected Bot's threads, and the shell's state. */
export interface OverlayRecords {
  readonly operator: boolean;
  readonly bots: readonly Bot[];
  readonly threads: readonly Thread[];
}

export interface OverlayCallbacks {
  readonly records: () => OverlayRecords;
  /** The workspace read the modal shows, through the same call the Library reads with. */
  readonly readFile: (path: string) => Promise<{
    readonly path: string;
    readonly text: string;
    readonly size: number;
  }>;
  /** Who performs a chosen command. One arm per `run`, each one a control the app already has. */
  readonly run: (command: OverlayCommand) => Promise<void> | void;
}

export interface OverlayHandle {
  /** Open the palette, as `Cmd/Ctrl+K`, `Cmd/Ctrl+Shift+F` and the sidebar's search button do. */
  openPalette(mode: PaletteMode): void;
  /** Open the picker, as `Cmd/Ctrl+N` and the sidebar's `New chat` button do. */
  openPicker(): void;
  /** Open the modal on a file, as a Library row does. Reads it, then shows what came back. */
  openFile(path: string): Promise<void>;
  /** Close the topmost overlay, as Escape and the scrim do. */
  close(): void;
  stack(): readonly OverlayId[];
  facts(): OverlayFacts;
}

export interface OverlayFacts {
  readonly stack: string[];
  readonly scrims: number;
  /** Nodes wearing the export's `hidden` class anywhere on the page. It must stay at zero. */
  readonly hiddenClass: number;
  readonly focus: { readonly tag: string; readonly id: string; readonly inside: string | null };
  readonly palette: {
    readonly open: boolean;
    readonly mode: string;
    readonly query: string;
    readonly placeholder: string;
    readonly groups: string[];
    readonly rows: string[];
    readonly subs: string[];
    readonly marks: string[];
    readonly active: number;
    readonly activeLabel: string | null;
    readonly ariaSelected: string[];
    readonly note: string | null;
  };
  readonly picker: {
    readonly open: boolean;
    readonly query: string;
    readonly placeholder: string;
    readonly rows: string[];
    readonly disabled: boolean[];
    readonly hint: string | null;
  };
  readonly modal: {
    readonly open: boolean;
    readonly role: string | null;
    readonly ariaModal: string | null;
    readonly wide: boolean;
    readonly title: string;
    readonly path: string;
    readonly size: string;
    readonly text: string | null;
    readonly refusal: string | null;
    readonly scrolls: boolean;
    readonly closeLabel: string | null;
    readonly closeIcon: string | null;
  };
}

declare global {
  interface Window {
    /** Live overlay facts, read from the DOM, for the CDP harness. */
    __overlayFacts?: () => OverlayFacts;
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

export function mountOverlays(config: OverlayCallbacks): OverlayHandle {
  const searchButton = must<HTMLButtonElement>("#sidebar-search");
  const newChatButton = must<HTMLButtonElement>("#sidebar-new-chat");

  /** The element that had the focus when an overlay opened, which is where it goes back. */
  interface Open {
    readonly id: OverlayId;
    readonly restore: HTMLElement | null;
  }
  /** The export opens one at a time, so this is one deep; Escape pops its top and nothing below. */
  const stack: Open[] = [];
  let scrimEl: HTMLElement | null = null;
  let creating = false;

  // ── the sidebar's two controls, which are the export's own two ────────────
  searchButton.addEventListener("click", () => openPalette("all"));
  newChatButton.addEventListener("click", () => openPicker());

  function records(): OverlayRecords {
    return config.records();
  }

  function top(): Open | null {
    return stack.length === 0 ? null : (stack[stack.length - 1] ?? null);
  }

  function attachScrim(): void {
    scrimEl = el("div", "scrim");
    scrimEl.addEventListener("click", () => handle.close());
    document.body.append(scrimEl);
  }

  function begin(id: OverlayId, panel: HTMLElement): void {
    // One at a time, the export's own rule: an opener closes whatever was up first.
    while (top() !== null) closeTop();
    const restore = document.activeElement;
    stack.push({ id, restore: restore instanceof HTMLElement ? restore : null });
    attachScrim();
    document.body.append(panel);
  }

  function closeTop(): void {
    const open = stack.pop();
    if (open === undefined) return;
    scrimEl?.remove();
    scrimEl = null;
    panelFor(open.id)?.remove();
    if (open.restore?.isConnected) open.restore.focus();
  }

  function panelFor(id: OverlayId): HTMLElement | null {
    if (id === "palette") return paletteEl;
    if (id === "picker") return pickerEl;
    return modalEl;
  }

  // ── the palette ───────────────────────────────────────────────────────────
  let paletteEl: HTMLElement | null = null;
  let paletteInput: HTMLInputElement | null = null;
  let paletteList: HTMLElement | null = null;
  let paletteMode: PaletteMode = "all";
  let paletteRowsShown: readonly PaletteRow[] = [];
  let paletteActive = 0;

  function ensurePalette(): { panel: HTMLElement; input: HTMLInputElement; list: HTMLElement } {
    if (paletteEl === null || paletteInput === null || paletteList === null) {
      paletteEl = el("div", "palette");
      paletteEl.id = "palette";
      paletteEl.setAttribute("role", "dialog");
      paletteEl.setAttribute("aria-modal", "true");
      paletteEl.setAttribute("aria-label", "Command palette");
      paletteInput = el("input");
      paletteInput.id = "palette-input";
      paletteInput.type = "text";
      paletteInput.autocomplete = "off";
      paletteInput.placeholder = PALETTE_PLACEHOLDER;
      paletteInput.setAttribute("aria-controls", "palette-list");
      paletteList = el("div", "palette-list");
      paletteList.id = "palette-list";
      paletteInput.addEventListener("input", () => {
        paletteActive = 0;
        paintPalette();
      });
      paletteEl.append(paletteInput, paletteList);
    }
    return { panel: paletteEl, input: paletteInput, list: paletteList };
  }

  function paletteRowNode(row: PaletteRow, index: number): HTMLElement {
    const node = el("button", "pop-item");
    node.type = "button";
    node.id = `palette-row-${index}`;
    node.dataset.row = String(index);
    node.dataset.kind = row.kind;
    const marked = markLabel(row.label, paletteInput?.value ?? "");
    const label = el("span");
    if (marked.hit === "") {
      label.textContent = row.label;
    } else {
      label.append(
        document.createTextNode(marked.before),
        el("mark", "", marked.hit),
        document.createTextNode(marked.after),
      );
    }
    node.append(label, el("span", "sub", row.kind));
    node.addEventListener("mousemove", () => {
      paletteActive = index;
      paintPaletteActive();
    });
    node.addEventListener("click", () => void perform(row.command, node));
    return node;
  }

  function paintPalette(): void {
    const { input, list } = ensurePalette();
    const all = paletteRows({
      mode: paletteMode,
      bots: records().bots,
      threads: records().threads,
    });
    paletteRowsShown = matchPalette(all, input.value);
    paletteActive = Math.min(paletteActive, Math.max(0, paletteRowsShown.length - 1));
    const children: Node[] = [];
    let lastGroup = "";
    for (const [index, row] of paletteRowsShown.entries()) {
      if (row.group !== lastGroup) {
        children.push(el("div", "pal-group", row.group));
        lastGroup = row.group;
      }
      children.push(paletteRowNode(row, index));
    }
    if (paletteRowsShown.length === 0) children.push(el("p", "palette-note", PALETTE_NO_RESULTS));
    list.replaceChildren(...children);
    paintPaletteActive();
  }

  /** The active row is the row the arrows moved to, which Enter chooses. */
  function paintPaletteActive(): void {
    const { input, list } = ensurePalette();
    for (const node of list.querySelectorAll<HTMLElement>(".pop-item")) {
      const active = Number(node.dataset.row ?? "-1") === paletteActive;
      node.dataset.active = String(active);
      node.setAttribute("aria-selected", String(active));
    }
    const current = list.querySelector<HTMLElement>(`[data-row="${paletteActive}"]`);
    if (current === null) input.removeAttribute("aria-activedescendant");
    else input.setAttribute("aria-activedescendant", current.id);
  }

  function openPalette(mode: PaletteMode): void {
    if (!records().operator) return;
    const { panel, input } = ensurePalette();
    paletteMode = mode;
    input.value = "";
    paletteActive = 0;
    begin("palette", panel);
    paintPalette();
    input.focus();
  }

  // ── the picker ────────────────────────────────────────────────────────────
  let pickerEl: HTMLElement | null = null;
  let pickerInput: HTMLInputElement | null = null;
  let pickerList: HTMLElement | null = null;
  let pickerActive = 0;

  function ensurePicker(): { panel: HTMLElement; input: HTMLInputElement; list: HTMLElement } {
    if (pickerEl === null || pickerInput === null || pickerList === null) {
      pickerEl = el("div", "picker");
      pickerEl.id = "picker";
      pickerEl.setAttribute("role", "dialog");
      pickerEl.setAttribute("aria-modal", "true");
      pickerEl.setAttribute("aria-label", "New chat");
      pickerInput = el("input");
      pickerInput.id = "picker-input";
      pickerInput.type = "text";
      pickerInput.autocomplete = "off";
      pickerInput.placeholder = PICKER_PLACEHOLDER;
      pickerInput.setAttribute("aria-controls", "picker-list");
      pickerList = el("div", "picker-list");
      pickerList.id = "picker-list";
      pickerInput.addEventListener("input", () => {
        pickerActive = 0;
        paintPicker();
      });
      pickerEl.append(pickerInput, pickerList);
    }
    return { panel: pickerEl, input: pickerInput, list: pickerList };
  }

  function paintPicker(): void {
    const { input, list } = ensurePicker();
    const model = pickerRows({ bots: records().bots, query: input.value });
    pickerActive = Math.min(pickerActive, Math.max(0, model.rows.length - 1));
    const children: Node[] = [];
    for (const [index, row] of model.rows.entries()) {
      const node = el("button", "pop-item");
      node.type = "button";
      node.id = `picker-row-${index}`;
      node.dataset.row = String(index);
      node.dataset.kind = row.kind;
      if (row.kind === "create") {
        node.append(el("span", "dot"), el("span", "nm", row.label), el("span", "sub", "new"));
        node.addEventListener(
          "click",
          () => void perform({ run: "create-bot", name: row.name }, node),
        );
      } else {
        node.append(el("span", "nm", row.label), el("span", "sub", row.sub));
        node.addEventListener(
          "click",
          () => void perform({ run: "select-bot", botId: row.botId }, node),
        );
      }
      children.push(node);
    }
    if (model.hint !== null) children.push(el("p", "picker-hint", model.hint));
    list.replaceChildren(...children);
    paintPickerActive();
  }

  function paintPickerActive(): void {
    const { input, list } = ensurePicker();
    for (const node of list.querySelectorAll<HTMLElement>(".pop-item")) {
      const active = Number(node.dataset.row ?? "-1") === pickerActive;
      node.dataset.active = String(active);
      node.setAttribute("aria-selected", String(active));
    }
    const current = list.querySelector<HTMLElement>(`[data-row="${pickerActive}"]`);
    if (current === null) input.removeAttribute("aria-activedescendant");
    else input.setAttribute("aria-activedescendant", current.id);
  }

  function openPicker(): void {
    if (!records().operator) return;
    const { panel, input } = ensurePicker();
    input.value = "";
    pickerActive = 0;
    begin("picker", panel);
    paintPicker();
    input.focus();
  }

  // ── the modal ─────────────────────────────────────────────────────────────
  let modalEl: HTMLElement | null = null;
  let modalClose: HTMLButtonElement | null = null;
  let modalTitle: HTMLElement | null = null;
  let modalPath: HTMLElement | null = null;
  let modalSize: HTMLElement | null = null;
  let modalText: HTMLElement | null = null;
  let modalRefusal: HTMLElement | null = null;

  function ensureModal(): HTMLElement {
    if (modalEl === null) {
      modalEl = el("div", "modal wide");
      modalEl.id = "modal";
      modalEl.setAttribute("role", "dialog");
      modalEl.setAttribute("aria-modal", "true");
      const head = el("div", "modal-head");
      modalTitle = el("h3", "grow");
      modalClose = el("button", "iconbtn");
      modalClose.type = "button";
      modalClose.setAttribute("aria-label", "Close");
      modalClose.append(icon("x"));
      modalClose.addEventListener("click", () => handle.close());
      head.append(modalTitle, modalClose);
      const meta = el("div", "modal-meta");
      modalPath = el("span", "mono fs-meta muted");
      modalSize = el("span", "tag");
      meta.append(modalPath, modalSize);
      modalText = el("pre", "modal-file");
      modalRefusal = el("p", "modal-refused");
      modalEl.append(head, meta, modalText, modalRefusal);
    }
    return modalEl;
  }

  /** Put one file on screen: the bytes, or the named refusal and no bytes. */
  function paintFile(file: OverlayFile): void {
    const panel = ensureModal();
    panel.setAttribute("aria-label", file.title);
    if (modalTitle !== null) modalTitle.textContent = file.title;
    if (modalPath !== null) modalPath.textContent = file.path;
    if (modalSize !== null) modalSize.textContent = file.size;
    if (modalText !== null) {
      modalText.textContent = file.text ?? "";
      modalText.hidden = file.text === null;
    }
    if (modalRefusal !== null) {
      modalRefusal.textContent = file.refusal ?? "";
      modalRefusal.hidden = file.refusal === null;
    }
  }

  async function openFile(path: string): Promise<void> {
    if (!records().operator) return;
    let file: OverlayFile;
    try {
      file = fileFromRead(await config.readFile(path));
    } catch (error) {
      // A refusal is a state of the modal, not a failure of it: the export has no refusal, this app's
      // reads have named ones, so the reason is what the body shows.
      file = fileFromRefusal(path, refusalCode(error));
    }
    const panel = ensureModal();
    begin("modal", panel);
    paintFile(file);
    modalClose?.focus();
  }

  // ── what choosing a row does ──────────────────────────────────────────────
  /**
   * Run one row's command. The palette's `New Bot` is this module's own door and opens the picker,
   * which is where the export's sidebar `+` leads; every other command goes to the host, whose arms
   * are the same calls the matching buttons make.
   */
  async function perform(command: OverlayCommand, row: HTMLElement | null): Promise<void> {
    if (command.run === "new-bot") {
      openPicker();
      return;
    }
    if (command.run === "create-bot") {
      if (creating) return;
      creating = true;
      if (row !== null) {
        row
          .querySelector<HTMLElement>(".nm")
          ?.replaceChildren(document.createTextNode(CREATING_LABEL));
        if (row instanceof HTMLButtonElement) row.disabled = true;
      }
      try {
        await config.run(command);
      } finally {
        creating = false;
      }
      handle.close();
      return;
    }
    handle.close();
    await config.run(command);
  }

  function move(delta: number): void {
    const open = top();
    if (open === null) return;
    const list = open.id === "palette" ? paletteList : pickerList;
    const count = list?.querySelectorAll(".pop-item").length ?? 0;
    if (count === 0) return;
    if (open.id === "palette") paletteActive = (paletteActive + delta + count) % count;
    else pickerActive = (pickerActive + delta + count) % count;
    if (open.id === "palette") paintPaletteActive();
    else paintPickerActive();
  }

  async function choose(): Promise<void> {
    const open = top();
    if (open === null) return;
    const list = open.id === "palette" ? paletteList : pickerList;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (row === null || row === undefined) return;
    row.click();
  }

  /** Tab stays inside the open panel: the last focusable wraps to the first and the first to the last. */
  function trapTab(event: KeyboardEvent): void {
    const open = top();
    if (open === null) return;
    const panel = panelFor(open.id);
    if (panel === null) return;
    const focusables = [...panel.querySelectorAll<HTMLElement>("input, button")].filter(
      (node) => !(node instanceof HTMLButtonElement && node.disabled),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (first === undefined || last === undefined) return;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      if (top() === null) return;
      event.preventDefault();
      handle.close();
      return;
    }
    if (meta && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openPalette("bots");
      return;
    }
    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette("all");
      return;
    }
    if (meta && event.key.toLowerCase() === "n") {
      event.preventDefault();
      openPicker();
      return;
    }
    const open = top();
    if (open === null) return;
    if (event.key === "Tab") {
      trapTab(event);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    const input = open.id === "palette" ? paletteInput : pickerInput;
    if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      void choose();
    }
  }

  document.addEventListener("keydown", onKeydown);

  const handle: OverlayHandle = {
    openPalette,
    openPicker,
    openFile,
    close: () => closeTop(),
    stack: () => stack.map((entry) => entry.id),
    facts() {
      const panel = top();
      const focusNode = document.activeElement;
      const palette = paletteEl;
      const picker = pickerEl;
      const modal = modalEl;
      const rowsOf = (list: HTMLElement | null): string[] =>
        [...(list?.querySelectorAll<HTMLElement>(".pop-item") ?? [])].map(
          (node) => (node.querySelector(".nm") ?? node.querySelector("span"))?.textContent ?? "",
        );
      return {
        stack: stack.map((entry) => entry.id),
        scrims: document.querySelectorAll(".scrim").length,
        hiddenClass: document.querySelectorAll(".hidden").length,
        focus: {
          tag: focusNode?.tagName.toLowerCase() ?? "",
          id: focusNode?.id ?? "",
          inside: panel === null ? null : panel.id,
        },
        palette: {
          open: palette !== null && panel?.id === "palette",
          mode: paletteMode,
          query: paletteInput?.value ?? "",
          placeholder: paletteInput?.placeholder ?? "",
          groups: [...(paletteList?.querySelectorAll<HTMLElement>(".pal-group") ?? [])].map(
            (node) => node.textContent ?? "",
          ),
          rows: rowsOf(paletteList),
          subs: [...(paletteList?.querySelectorAll<HTMLElement>(".pop-item .sub") ?? [])].map(
            (node) => node.textContent ?? "",
          ),
          marks: [...(paletteList?.querySelectorAll("mark") ?? [])].map(
            (node) => node.textContent ?? "",
          ),
          active: paletteActive,
          activeLabel:
            paletteList?.querySelector<HTMLElement>('[data-active="true"] span')?.textContent ??
            null,
          ariaSelected: [...(paletteList?.querySelectorAll<HTMLElement>(".pop-item") ?? [])].map(
            (node) => node.getAttribute("aria-selected") ?? "",
          ),
          note: paletteList?.querySelector(".palette-note")?.textContent ?? null,
        },
        picker: {
          open: picker !== null && panel?.id === "picker",
          query: pickerInput?.value ?? "",
          placeholder: pickerInput?.placeholder ?? "",
          rows: rowsOf(pickerList),
          disabled: [...(pickerList?.querySelectorAll<HTMLButtonElement>(".pop-item") ?? [])].map(
            (node) => node.disabled,
          ),
          hint: pickerList?.querySelector(".picker-hint")?.textContent ?? null,
        },
        modal: {
          open: modal !== null && panel?.id === "modal",
          role: modal?.getAttribute("role") ?? null,
          ariaModal: modal?.getAttribute("aria-modal") ?? null,
          wide: modal?.classList.contains("wide") ?? false,
          title: modalTitle?.textContent ?? "",
          path: modalPath?.textContent ?? "",
          size: modalSize?.textContent ?? "",
          text: modalText === null || modalText.hidden ? null : modalText.textContent,
          refusal: modalRefusal === null || modalRefusal.hidden ? null : modalRefusal.textContent,
          // The panel itself, or the file box inside it, is what scrolls: a long file scrolls in
          // place rather than pushing the panel past the viewport it was measured in.
          scrolls:
            modal !== null &&
            (modal.scrollHeight > modal.clientHeight ||
              (modalText !== null && modalText.scrollHeight > modalText.clientHeight)),
          closeLabel: modalClose?.getAttribute("aria-label") ?? null,
          closeIcon: modalClose?.querySelector("use")?.getAttribute("href") ?? null,
        },
      };
    },
  };

  return handle;
}

/** Expose the live overlay facts on `window`, so a CDP driver reads the page. */
export function exposeOverlayFacts(handle: OverlayHandle): void {
  window.__overlayFacts = () => handle.facts();
}
