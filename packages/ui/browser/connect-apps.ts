/**
 * The Connect apps screen's DOM: the gallery, one connector's detail, and the add form.
 *
 * It decides nothing. `packages/ui/src/connections.ts` owns the state vocabulary, the failure
 * control each state offers, and the deltas this record cannot close; this module turns those into
 * nodes and reads them back for the evidence driver, the split `provider.ts` keeps with its page.
 *
 * The four calls arrive as `calls`, already carrying the operator token, so nothing here knows what
 * a transport is. The credential input is the one place a value exists on this page: the field is
 * cleared the moment its call answers, and no fact this module exposes can carry one.
 *
 * The screen lives inside the Workspace page shell U6.8 landed. Moving between the gallery, a
 * detail and the add form is this module's own view state, so the Workspace nav and the sidebar
 * footer both land on the gallery and a re-open is a fresh read of the install's connectors.
 */

import type { ConnectConnectorInput, ConnectorRow } from "@freebot/protocol";
import {
  ADD_EYEBROW,
  ADD_LABEL,
  ADD_SAVE_LABEL,
  ADD_TITLE,
  addedLine,
  CANCEL_LABEL,
  CONNECT_APPS_EMPTY_BODY,
  CONNECT_APPS_EMPTY_TITLE,
  CONNECT_APPS_EYEBROW,
  CONNECT_APPS_TITLE,
  CONNECTOR_DELTAS,
  CONNECTOR_HEADER_NAME_LABEL,
  CONNECTOR_HEADER_NAME_PLACEHOLDER,
  CONNECTOR_HEADER_VALUE_LABEL,
  CONNECTOR_HEADER_VALUE_PLACEHOLDER,
  CONNECTOR_NAME_LABEL,
  CONNECTOR_NAME_PLACEHOLDER,
  CONNECTOR_URL_LABEL,
  CONNECTOR_URL_PLACEHOLDER,
  type ConnectAppsFacts,
  type ConnectionView,
  CREDENTIAL_NOTE,
  connectionSummary,
  connectionView,
  connectionViews,
  connectorIdFrom,
  detailActions,
  HEADER_NOTE,
  removedLine,
  savedCredentialLine,
  testedResultLine,
} from "../src/connections.ts";
import { actionButton, backButton, el, emptyState, icon, kv, pageShell, tag } from "./page.ts";

export interface ConnectAppsCalls {
  readonly list: () => Promise<readonly ConnectorRow[]>;
  readonly connect: (input: ConnectConnectorInput) => Promise<ConnectorRow>;
  readonly test: (id: string) => Promise<ConnectorRow>;
  readonly remove: (id: string) => Promise<{ id: string; removed: boolean }>;
}

export interface ConnectAppsConfig {
  /** The Workspace page element. The screen replaces its contents, the way every page does. */
  readonly container: HTMLElement;
  readonly calls: ConnectAppsCalls;
  readonly onLeave: () => void;
  /** Fired after every read of the install's connectors. The sidebar's count reads this. */
  readonly onRecords?: (rows: readonly ConnectorRow[]) => void;
}

export interface ConnectAppsHandle {
  /** Show the gallery, reading the install's connectors first. A re-open is a fresh read. */
  open(): Promise<void>;
  /** Repaint from the state already held. */
  render(): void;
  facts(): ConnectAppsFacts;
  rows(): readonly ConnectorRow[];
}

declare global {
  interface Window {
    /** Live Connect apps facts, read from the DOM, for the CDP driver. */
    __connectAppsFacts?: () => ConnectAppsFacts;
  }
}

type Screen = "gallery" | "detail" | "add";

interface CredentialDraft {
  headerName: string;
  headerValue: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freshDraft(): CredentialDraft & { label: string; url: string } {
  return { label: "", url: "", headerName: "authorization", headerValue: "" };
}

export function mountConnectApps(config: ConnectAppsConfig): ConnectAppsHandle {
  const { container } = config;
  let screen: Screen = "gallery";
  let rows: readonly ConnectorRow[] = [];
  let selectedId: string | null = null;
  let draft = freshDraft();
  let credential: CredentialDraft = { headerName: "authorization", headerValue: "" };
  let credentialOpen = false;
  let confirmRemove = false;
  let busy: string | null = null;
  let error: string | null = null;
  let notice: string | null = null;
  let loading = false;

  function selectedRow(): ConnectorRow | null {
    return rows.find((row) => row.id === selectedId) ?? null;
  }

  function field(label: string, input: HTMLInputElement): HTMLElement {
    const box = el("div", "field");
    const labelNode = el("label", "", label);
    labelNode.setAttribute("for", input.id);
    box.append(labelNode, input);
    return box;
  }

  function textInput(
    id: string,
    placeholder: string,
    value: string,
    onInput: (next: string) => void,
  ): HTMLInputElement {
    const input = el("input", "input");
    input.id = id;
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function messageNodes(): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    if (error !== null) {
      const line = el("p", "fs-meta", error);
      line.id = "connections-error";
      nodes.push(line);
    }
    if (notice !== null) {
      const line = el("p", "hint", notice);
      line.id = "connections-notice";
      nodes.push(line);
    }
    return nodes;
  }

  function deltasCard(): HTMLElement {
    const box = el("div", "card");
    box.id = "connections-deltas";
    box.append(el("span", "cap", "What this screen does not carry"));
    for (const delta of CONNECTOR_DELTAS) {
      const title = el("p", "fs-meta", delta.title);
      title.style.marginTop = "8px";
      box.append(title, el("p", "hint", delta.reason));
    }
    return box;
  }

  function galleryRow(view: ConnectionView): HTMLButtonElement {
    const row = el("button", "listrow");
    row.type = "button";
    row.dataset.connector = view.id;
    row.dataset.state = view.state;
    const copy = el("span", "grow");
    const name = el("span", "", view.label);
    name.style.display = "block";
    name.style.fontFamily = "var(--font-display)";
    name.style.fontSize = "14px";
    name.style.fontWeight = "600";
    const url = el("span", "hint truncate", view.url);
    url.style.display = "block";
    copy.append(name, url);
    row.append(
      el("span", "monogram", view.monogram),
      copy,
      tag(
        view.stateLabel,
        view.state === "connected" ? "solid" : view.state === "untested" ? "dim" : "",
      ),
    );
    row.addEventListener("click", () => {
      screen = "detail";
      selectedId = view.id;
      credentialOpen = false;
      confirmRemove = false;
      error = null;
      notice = null;
      render();
    });
    return row;
  }

  function galleryPage(): HTMLElement {
    const body = messageNodes();
    if (loading) {
      body.push(el("p", "hint", "Reading this install's connectors..."));
    } else if (rows.length === 0) {
      body.push(emptyState(CONNECT_APPS_EMPTY_TITLE, CONNECT_APPS_EMPTY_BODY));
    } else {
      const summary = connectionSummary(rows);
      const list = el("div", "listcard");
      list.id = "connections-list";
      for (const view of connectionViews(rows)) list.append(galleryRow(view));
      body.push(
        el(
          "p",
          "hint",
          `${summary.total} connector${summary.total === 1 ? "" : "s"}, ${summary.on} connected, ${summary.attention} needing attention.`,
        ),
        list,
      );
    }
    body.push(deltasCard());
    const add = actionButton(ADD_LABEL, "plus", openAdd, "btn-secondary", loading);
    add.id = "connections-add";
    return pageShell(
      CONNECT_APPS_TITLE,
      CONNECT_APPS_EYEBROW,
      [add, backButton(config.onLeave)],
      body,
    );
  }

  function credentialFields(
    idPrefix: string,
    read: () => CredentialDraft,
    update: (next: CredentialDraft) => void,
  ): HTMLElement[] {
    const current = read();
    const name = textInput(
      `${idPrefix}-header-name`,
      CONNECTOR_HEADER_NAME_PLACEHOLDER,
      current.headerName,
      (next) => update({ ...read(), headerName: next }),
    );
    const value = el("input", "input");
    value.id = `${idPrefix}-header-value`;
    value.type = "password";
    value.autocomplete = "off";
    value.placeholder = CONNECTOR_HEADER_VALUE_PLACEHOLDER;
    value.value = current.headerValue;
    value.addEventListener("input", () => update({ ...read(), headerValue: value.value }));
    return [field(CONNECTOR_HEADER_NAME_LABEL, name), field(CONNECTOR_HEADER_VALUE_LABEL, value)];
  }

  function addPage(): HTMLElement {
    const form = el("form", "card");
    form.id = "connector-form";
    form.append(el("span", "cap", "New connector"));
    const name = textInput(
      "connector-label",
      CONNECTOR_NAME_PLACEHOLDER,
      draft.label,
      (next) => (draft = { ...draft, label: next }),
    );
    const url = textInput(
      "connector-url",
      CONNECTOR_URL_PLACEHOLDER,
      draft.url,
      (next) => (draft = { ...draft, url: next }),
    );
    const fields = el("div", "stack");
    fields.append(field(CONNECTOR_NAME_LABEL, name), field(CONNECTOR_URL_LABEL, url));
    fields.append(
      ...credentialFields(
        "connector",
        () => draft,
        (next) => (draft = { ...draft, ...next }),
      ),
    );
    const actions = el("div", "row");
    actions.style.marginTop = "18px";
    const save = el("button", "btn btn-secondary btn-sm");
    save.type = "submit";
    save.id = "connector-save";
    save.textContent = ADD_SAVE_LABEL;
    save.disabled = busy !== null;
    const cancel = el("button", "btn btn-ghost btn-sm");
    cancel.type = "button";
    cancel.id = "connector-cancel";
    cancel.textContent = CANCEL_LABEL;
    cancel.addEventListener("click", () => {
      draft = freshDraft();
      screen = "gallery";
      error = null;
      render();
    });
    actions.append(save, cancel);
    form.append(fields, el("p", "hint", HEADER_NOTE), el("p", "hint", CREDENTIAL_NOTE), actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveNew();
    });
    return pageShell(
      ADD_TITLE,
      ADD_EYEBROW,
      [backButton(config.onLeave)],
      [...messageNodes(), form],
    );
  }

  function credentialForm(row: ConnectorRow): HTMLElement {
    const form = el("form", "card");
    form.id = "connector-credential-form";
    form.append(
      el(
        "span",
        "cap",
        row.state === "untested" ? "Authorize this connector" : "Replace the credential",
      ),
    );
    const fields = el("div", "stack");
    fields.append(
      ...credentialFields(
        "connector-credential",
        () => credential,
        (next) => (credential = next),
      ),
    );
    const actions = el("div", "row");
    actions.style.marginTop = "16px";
    const save = el("button", "btn btn-secondary btn-sm");
    save.type = "submit";
    save.id = "connector-credential-save";
    save.textContent = "Save and probe";
    save.disabled = busy !== null;
    const cancel = el("button", "btn btn-ghost btn-sm");
    cancel.type = "button";
    cancel.id = "connector-credential-cancel";
    cancel.textContent = CANCEL_LABEL;
    cancel.addEventListener("click", () => {
      credentialOpen = false;
      credential = { headerName: "authorization", headerValue: "" };
      render();
    });
    actions.append(save, cancel);
    form.append(fields, el("p", "hint", CREDENTIAL_NOTE), actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveCredential(row);
    });
    return form;
  }

  function confirmBlock(row: ConnectorRow): HTMLElement {
    const box = el("div", "card");
    box.id = "connector-remove-confirm";
    box.append(
      el("span", "cap", "Remove this connector"),
      el(
        "p",
        "hint",
        `Removing ${row.label} takes its record and the credential the vault holds for it. A connector you add again starts from a new probe.`,
      ),
    );
    const actions = el("div", "row");
    actions.style.marginTop = "14px";
    const yes = el("button", "btn btn-secondary btn-sm");
    yes.type = "button";
    yes.id = "connector-remove-yes";
    yes.textContent = "Remove";
    yes.disabled = busy !== null;
    yes.addEventListener("click", () => void removeRow(row));
    const no = el("button", "btn btn-ghost btn-sm");
    no.type = "button";
    no.id = "connector-remove-no";
    no.textContent = CANCEL_LABEL;
    no.addEventListener("click", () => {
      confirmRemove = false;
      render();
    });
    actions.append(yes, no);
    box.append(actions);
    return box;
  }

  function toolsCard(view: ConnectionView): HTMLElement {
    const box = el("div", "card");
    box.append(el("span", "cap", "Tools this connector offers"));
    if (view.tools.length === 0) {
      box.append(
        el(
          "p",
          "hint",
          view.state === "connected"
            ? "The probe answered, and the server offered no tools."
            : "No tools yet. A probe is what reads them from the server.",
        ),
      );
      return box;
    }
    const list = el("div", "stack");
    list.id = "connector-tools";
    for (const tool of view.tools) {
      const row = el("div", "connector-tool");
      row.dataset.tool = tool.name;
      row.append(el("p", "fs-meta", tool.name), el("p", "hint", tool.description));
      list.append(row);
    }
    box.append(list);
    return box;
  }

  function detailPage(row: ConnectorRow): HTMLElement {
    const view = connectionView(row);
    const body = messageNodes();
    const stateLine = el("p", "hint", view.stateLine);
    stateLine.id = "connector-state-line";
    body.push(stateLine);

    const connection = el("div", "card");
    connection.id = "connector-detail";
    connection.dataset.detailConnector = view.id;
    connection.dataset.state = view.state;
    connection.append(el("span", "cap", "Connection"));
    const stateRow = el("div", "row-between");
    stateRow.append(
      el("span", "fs-meta", view.stateLabel),
      tag(
        view.stateLabel,
        view.state === "connected" ? "solid" : view.state === "untested" ? "dim" : "",
      ),
    );
    connection.append(stateRow);
    const refused = el("p", "hint", view.detail === "" ? "No probe has run." : view.detail);
    refused.id = "connector-detail-line";
    refused.style.marginTop = "10px";
    connection.append(
      refused,
      kv("Endpoint", view.url),
      kv("Credential", view.ref),
      kv("Last probe", view.testedLine),
      kv("Tools", String(view.toolCount)),
    );

    const actions = el("div", "row");
    actions.style.marginTop = "14px";
    actions.style.flexWrap = "wrap";
    for (const action of detailActions(view.state)) {
      actions.append(actionElement(row, action.id, action.label));
    }
    const remove = el("button", "btn btn-ghost btn-sm");
    remove.type = "button";
    remove.id = "connector-remove";
    remove.disabled = busy !== null;
    remove.append(icon("warn"), document.createTextNode("Remove"));
    remove.addEventListener("click", () => {
      confirmRemove = true;
      render();
    });
    actions.append(remove);
    connection.append(actions);
    if (credentialOpen) connection.append(credentialForm(row));
    body.push(connection);
    if (confirmRemove) body.push(confirmBlock(row));
    body.push(toolsCard(view));

    const back = actionButton(
      "Back to apps",
      "grid",
      () => {
        screen = "gallery";
        selectedId = null;
        credentialOpen = false;
        confirmRemove = false;
        error = null;
        notice = null;
        render();
      },
      "btn-ghost",
    );
    back.id = "connections-back";
    return pageShell(view.label, `App · ${view.id}`, [back, backButton(config.onLeave)], body);
  }

  function actionElement(
    row: ConnectorRow,
    id: "test" | "retry" | "authorize" | "reconnect",
    label: string,
  ): HTMLButtonElement {
    const button = el("button", "btn btn-ghost btn-sm");
    button.type = "button";
    button.id = `connector-action-${id}`;
    button.disabled = busy !== null;
    button.textContent = label;
    button.addEventListener("click", () => {
      if (id === "test" || id === "retry") void testRow(row);
      else {
        credential = { headerName: "authorization", headerValue: "" };
        credentialOpen = true;
        error = null;
        render();
      }
    });
    return button;
  }

  function render(): void {
    if (screen === "add") {
      container.replaceChildren(addPage());
      return;
    }
    const row = selectedRow();
    if (screen === "detail" && row !== null) {
      container.replaceChildren(detailPage(row));
      return;
    }
    container.replaceChildren(galleryPage());
  }

  async function act(key: string, body: () => Promise<void>): Promise<void> {
    if (busy !== null) return;
    busy = key;
    error = null;
    render();
    try {
      await body();
    } catch (thrown) {
      error = messageOf(thrown);
    } finally {
      busy = null;
      render();
    }
  }

  function openAdd(): void {
    draft = freshDraft();
    screen = "add";
    error = null;
    notice = null;
    render();
  }

  async function saveNew(): Promise<void> {
    const label = draft.label.trim();
    const url = draft.url.trim();
    const headerName = draft.headerName.trim() === "" ? "authorization" : draft.headerName.trim();
    const headerValue = draft.headerValue;
    if (label === "" || url === "" || headerValue === "") {
      error = "A name, an endpoint and a credential are all needed before the probe can run.";
      render();
      return;
    }
    const id = connectorIdFrom(
      label,
      rows.map((row) => row.id),
    );
    await act("connect", async () => {
      try {
        const saved = await config.calls.connect({
          id,
          label,
          url,
          headers: { [headerName]: headerValue },
        });
        try {
          rows = await config.calls.list();
        } catch {
          rows = [saved];
        }
        config.onRecords?.(rows);
        selectedId = id;
        screen = "detail";
        notice = addedLine(label, saved.state);
      } finally {
        // The credential leaves this page the moment its call answers, refused or not.
        draft = { ...draft, headerValue: "" };
      }
    });
  }

  async function saveCredential(row: ConnectorRow): Promise<void> {
    const headerName =
      credential.headerName.trim() === "" ? "authorization" : credential.headerName.trim();
    const headerValue = credential.headerValue;
    if (headerValue === "") {
      error = "A credential is needed before the probe can run.";
      render();
      return;
    }
    await act("credential", async () => {
      try {
        const saved = await config.calls.connect({
          id: row.id,
          label: row.label,
          url: row.url,
          headers: { [headerName]: headerValue },
        });
        try {
          rows = await config.calls.list();
        } catch {
          rows = rows.map((held) => (held.id === row.id ? saved : held));
        }
        config.onRecords?.(rows);
        credentialOpen = false;
        notice = savedCredentialLine(row.label, saved.state);
      } finally {
        credential = { headerName: "authorization", headerValue: "" };
      }
    });
  }

  async function testRow(row: ConnectorRow): Promise<void> {
    await act(`test:${row.id}`, async () => {
      const answer = await config.calls.test(row.id);
      rows = rows.map((held) => (held.id === row.id ? answer : held));
      config.onRecords?.(rows);
      notice = testedResultLine(answer.label, answer.state);
    });
  }

  async function removeRow(row: ConnectorRow): Promise<void> {
    await act(`remove:${row.id}`, async () => {
      const answer = await config.calls.remove(row.id);
      try {
        rows = await config.calls.list();
      } catch {
        rows = rows.filter((held) => held.id !== row.id);
      }
      config.onRecords?.(rows);
      confirmRemove = false;
      screen = "gallery";
      selectedId = null;
      notice = removedLine(row.label, answer.removed);
    });
  }

  return {
    async open() {
      screen = "gallery";
      selectedId = null;
      draft = freshDraft();
      credential = { headerName: "authorization", headerValue: "" };
      credentialOpen = false;
      confirmRemove = false;
      error = null;
      notice = null;
      loading = true;
      render();
      try {
        rows = await config.calls.list();
      } catch (thrown) {
        rows = [];
        error = messageOf(thrown);
      }
      loading = false;
      config.onRecords?.(rows);
      render();
    },

    render,

    rows: () => rows,

    facts(): ConnectAppsFacts {
      const title = container.querySelector<HTMLElement>(".page-title h1")?.textContent ?? "";
      const addOpen = container.querySelector("#connector-form") !== null;
      const detailOpen = container.querySelector("#connector-detail") !== null;
      const view: ConnectAppsFacts["view"] = addOpen
        ? "add"
        : detailOpen
          ? "detail"
          : container.querySelector(".page-title") !== null
            ? "gallery"
            : "closed";
      const detailEl = container.querySelector<HTMLElement>("#connector-detail");
      const detail =
        detailEl === null
          ? null
          : {
              id: detailEl.dataset.detailConnector ?? "",
              label: title,
              state: detailEl.dataset.state ?? "",
              line: container.querySelector("#connector-state-line")?.textContent ?? "",
              refused: container.querySelector("#connector-detail-line")?.textContent ?? "",
              actions: [
                ...container.querySelectorAll<HTMLElement>(
                  "#connector-detail button[id^='connector-action-']",
                ),
              ].map((node) => node.textContent ?? ""),
              tools: [
                ...container.querySelectorAll<HTMLElement>("#connector-tools .connector-tool"),
              ].map((node) => node.dataset.tool ?? ""),
              ref:
                [...container.querySelectorAll<HTMLElement>("#connector-detail .kv")]
                  .find((node) => node.querySelector(".k")?.textContent === "Credential")
                  ?.querySelector(".v")?.textContent ?? "",
              tested:
                [...container.querySelectorAll<HTMLElement>("#connector-detail .kv")]
                  .find((node) => node.querySelector(".k")?.textContent === "Last probe")
                  ?.querySelector(".v")?.textContent ?? "",
            };
      const credentialInput = container.querySelector<HTMLInputElement>(
        "#connector-credential-header-value",
      );
      return {
        view,
        title,
        rows: [
          ...container.querySelectorAll<HTMLElement>("#connections-list [data-connector]"),
        ].map((node) => ({
          id: node.dataset.connector ?? "",
          label: node.querySelector(".grow > span")?.textContent ?? "",
          state: node.dataset.state ?? "",
          tag: node.querySelector(".tag")?.textContent ?? "",
        })),
        empty: container.querySelector(".empty-state") !== null,
        detail,
        add: addOpen
          ? {
              open: true,
              credentialEmpty:
                (container.querySelector<HTMLInputElement>("#connector-header-value")?.value ??
                  "") === "",
            }
          : null,
        credentialEmpty: credentialInput === null ? null : credentialInput.value === "",
        notice: container.querySelector("#connections-notice")?.textContent ?? null,
        error: container.querySelector("#connections-error")?.textContent ?? null,
        deltas: [...container.querySelectorAll<HTMLElement>("#connections-deltas .fs-meta")].map(
          (node) => node.textContent ?? "",
        ),
      };
    },
  };
}

/** Expose the screen's live facts on `window`, so a CDP driver reads the page. */
export function exposeConnectAppsFacts(handle: ConnectAppsHandle): void {
  window.__connectAppsFacts = () => handle.facts();
}
