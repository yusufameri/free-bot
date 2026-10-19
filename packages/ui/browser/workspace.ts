/**
 * The Workspace pages: Skills, Apps, Rules, Activity, Teams, Settings and Mobile surface.
 *
 * Each page is the export's page shell (`freebot-prototype.html:1385-1439` and the page functions
 * after it). A page renders only records this app really holds. Where the export seeds prototype
 * data and this app has no record, the page says so in the export's own empty-state shape instead of
 * inventing a row. The Settings page keeps its display preferences in `localStorage`, which is the
 * one preference store this build has; every other pane reports the install as it is.
 */

import type { Bot, ConnectorRow, ProviderConnection, Thread } from "@freebot/protocol";

export const WORKSPACE_VIEWS = [
  "skills",
  "apps",
  "rules",
  "activity",
  "teams",
  "settings",
  "mobile",
] as const;

export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];

export const WORKSPACE_LABELS: Record<WorkspaceView, string> = {
  skills: "Skills",
  apps: "Apps",
  rules: "Rules",
  activity: "Activity",
  teams: "Teams",
  settings: "Settings",
  mobile: "Mobile surface",
};

export interface ActivityRun {
  readonly runId: string;
  readonly botName: string;
  readonly threadTitle: string;
  readonly prompt: string;
  readonly status: string;
  readonly startedAt: number;
}

export interface WorkspaceRecords {
  readonly bots: readonly Bot[];
  readonly selectedBot: Bot | null;
  readonly threads: readonly Thread[];
  readonly provider: ProviderConnection | null;
  readonly runs: readonly ActivityRun[];
}

export interface WorkspaceCalls {
  readonly listConnectors: () => Promise<readonly ConnectorRow[]>;
}

export interface WorkspaceConfig {
  readonly read: () => WorkspaceRecords;
  readonly calls: WorkspaceCalls;
  /** Open page 1, which is where a provider connection is made. */
  readonly onOpenProvider: () => void;
  /** Select a Bot from a row, then leave the page for its conversation. */
  readonly onSelectBot: (botId: string) => void | Promise<void>;
  /** Leave the page and show the conversation column again. */
  readonly onLeave: () => void;
}

export interface WorkspaceHandle {
  show(view: WorkspaceView): Promise<void>;
  hide(): void;
  current(): WorkspaceView | null;
  repaint(): void;
}

type SettingsPane =
  | "providers"
  | "general"
  | "computer"
  | "usage"
  | "notifications"
  | "updates"
  | "danger";

const SETTINGS_PANES: ReadonlyArray<{ id: SettingsPane; label: string; icon: string }> = [
  { id: "providers", label: "Providers", icon: "cpu" },
  { id: "general", label: "General", icon: "settings" },
  { id: "computer", label: "Computer", icon: "desktop" },
  { id: "usage", label: "Usage", icon: "activity" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "updates", label: "Updates", icon: "refresh" },
  { id: "danger", label: "Danger zone", icon: "warn" },
];

const SETTINGS_KEY = "freebot.workspace.settings";

interface DisplaySettings {
  theme: "dark" | "light" | "system";
  accent: "monochrome" | "system blue";
  notify: {
    approvals: boolean;
    routines: boolean;
    finishes: boolean;
    replies: boolean;
    voice: boolean;
  };
}

function readSettings(): DisplaySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<DisplaySettings>;
      return {
        theme: parsed.theme ?? "dark",
        accent: parsed.accent ?? "monochrome",
        notify: {
          approvals: parsed.notify?.approvals ?? true,
          routines: parsed.notify?.routines ?? true,
          finishes: parsed.notify?.finishes ?? true,
          replies: parsed.notify?.replies ?? false,
          voice: parsed.notify?.voice ?? false,
        },
      };
    }
  } catch {
    // A malformed preference is a first-run preference.
  }
  return {
    theme: "dark",
    accent: "monochrome",
    notify: { approvals: true, routines: true, finishes: true, replies: false, voice: false },
  };
}

function saveSettings(settings: DisplaySettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A browser with storage disabled still gets the page, it just will not remember the pane.
  }
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

function icon(name: string, size: "ic" | "ic-sm" = "ic-sm"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", size);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function tag(text: string, variant: "" | "solid" | "dim" = ""): HTMLElement {
  return el("span", `tag${variant === "" ? "" : ` ${variant}`}`, text);
}

function kv(label: string, value: string): HTMLElement {
  const row = el("div", "kv");
  row.append(el("span", "k", label), el("span", "v", value));
  return row;
}

function card(children: readonly HTMLElement[], className = "card"): HTMLElement {
  const node = el("div", className);
  node.append(...children);
  return node;
}

function emptyState(title: string, body: string): HTMLElement {
  const box = el("div", "card empty-state");
  box.append(el("h3", "", title), el("p", "hint", body));
  return box;
}

function pageShell(
  title: string,
  eyebrow: string,
  actions: readonly HTMLElement[],
  body: readonly HTMLElement[],
  narrow = false,
): HTMLElement {
  const page = el("div", "page");
  const inner = el("div", `page-inner${narrow ? " narrow" : ""}`);
  const head = el("div", "page-title");
  const titles = el("div");
  titles.append(el("p", "eyebrow", eyebrow), el("h1", "", title));
  const controls = el("div", "row");
  controls.style.flexWrap = "wrap";
  controls.append(...actions);
  head.append(titles, controls);
  inner.append(head, ...body);
  page.append(inner);
  return page;
}

function backButton(onLeave: () => void): HTMLButtonElement {
  const button = el("button", "btn btn-ghost btn-sm");
  button.type = "button";
  button.append(icon("left"), document.createTextNode("Back to the conversation"));
  button.addEventListener("click", onLeave);
  return button;
}

function actionButton(
  label: string,
  iconName: string,
  onClick: () => void,
  variant: "btn-secondary" | "btn-ghost" = "btn-secondary",
  disabled = false,
): HTMLButtonElement {
  const button = el("button", `btn ${variant} btn-sm`);
  button.type = "button";
  button.disabled = disabled;
  button.append(icon(iconName), document.createTextNode(label));
  button.addEventListener("click", onClick);
  return button;
}

export function mountWorkspace(config: WorkspaceConfig): WorkspaceHandle {
  const pageEl = must<HTMLElement>("#page");
  let view: WorkspaceView | null = null;
  let connectors: readonly ConnectorRow[] = [];
  let connectorsError: string | null = null;
  let settingsPane: SettingsPane = "providers";
  let activityBot = "all";
  let activityStatus = "all";
  let settings = readSettings();

  function render(): void {
    if (view === null) return;
    const records = config.read();
    switch (view) {
      case "skills":
        pageEl.replaceChildren(skillsPage(config.onLeave));
        break;
      case "apps":
        pageEl.replaceChildren(appsPage(connectors, connectorsError, config));
        break;
      case "rules":
        pageEl.replaceChildren(rulesPage(config.onLeave));
        break;
      case "activity":
        pageEl.replaceChildren(
          activityPage(records.runs, activityBot, activityStatus, config.onLeave, (bot, status) => {
            activityBot = bot;
            activityStatus = status;
            render();
          }),
        );
        break;
      case "teams":
        pageEl.replaceChildren(teamsPage(config.onLeave));
        break;
      case "settings":
        pageEl.replaceChildren(
          settingsPage(records.provider, settingsPane, settings, {
            onPane: (pane) => {
              settingsPane = pane;
              render();
            },
            onOpenProvider: config.onOpenProvider,
            onSettings: (next) => {
              settings = next;
              saveSettings(settings);
              render();
            },
          }),
        );
        break;
      case "mobile":
        pageEl.replaceChildren(mobilePage(records.selectedBot, config.onLeave));
        break;
    }
  }

  function highlight(): void {
    for (const button of document.querySelectorAll<HTMLElement>("#nav-list [data-view]")) {
      button.classList.toggle("is-active", button.dataset.view === view);
    }
  }

  return {
    async show(next) {
      view = next;
      highlight();
      document.body.dataset.pageOpen = "true";
      pageEl.hidden = false;
      if (next === "apps") {
        connectorsError = null;
        try {
          connectors = await config.calls.listConnectors();
        } catch (error) {
          connectors = [];
          connectorsError = error instanceof Error ? error.message : String(error);
        }
      }
      render();
    },

    hide() {
      view = null;
      pageEl.hidden = true;
      pageEl.replaceChildren();
      delete document.body.dataset.pageOpen;
      highlight();
    },

    current: () => view,

    repaint() {
      render();
    },
  };
}

function skillsPage(onLeave: () => void): HTMLElement {
  const body: HTMLElement[] = [
    emptyState(
      "No skills yet",
      "A skill is a reusable procedure any Bot can run. This build holds no skill records, so the library is empty until the Skills unit lands.",
    ),
  ];
  const actions = [
    actionButton("Write a skill", "plus", () => undefined, "btn-secondary", true),
    actionButton("Teach a task", "play", () => undefined, "btn-ghost", true),
    backButton(onLeave),
  ];
  return pageShell("Skills", "Library · page 9", actions, body);
}

function appsPage(
  connectors: readonly ConnectorRow[],
  refusal: string | null,
  config: WorkspaceConfig,
): HTMLElement {
  const body: HTMLElement[] = [];
  if (refusal !== null) {
    const note = el("p", "hint");
    note.textContent = `The connector list could not be read. ${refusal}`;
    body.push(note);
  }
  if (connectors.length === 0 && refusal === null) {
    body.push(
      emptyState(
        "No apps connected",
        "A connector is added through the connector API today. The gallery below lists what this install holds, and a connected account appears here with the tools its own server offered.",
      ),
    );
  } else if (connectors.length > 0) {
    const list = el("div", "listcard");
    for (const connector of connectors) {
      const row = el("button", "listrow");
      row.type = "button";
      const monogram = el("span", "monogram", connector.label.slice(0, 2).toUpperCase());
      const copy = el("span", "grow");
      copy.append(el("span", "", connector.label));
      copy.lastElementChild?.setAttribute(
        "style",
        "display:block;font-size:14px;font-family:var(--font-display);font-weight:600",
      );
      copy.append(el("span", "hint truncate", connector.url));
      copy.lastElementChild?.setAttribute("style", "display:block");
      row.append(
        monogram,
        copy,
        tag(connector.state, connector.state === "connected" ? "solid" : "dim"),
      );
      list.append(row);
    }
    body.push(list);
  }
  const actions = [
    actionButton("Add a connection", "plus", config.onOpenProvider),
    actionButton("Connect apps", "grid", config.onOpenProvider, "btn-ghost"),
  ];
  return pageShell("Apps and connectors", "Gallery · page 12", actions, body);
}

function rulesPage(onLeave: () => void): HTMLElement {
  const left = el("div", "stack");
  left.append(
    emptyState(
      "No rules yet",
      "That is the safe default. A rule is written when a person answers Always allow, and this build keeps only the allow-once and deny decisions on a parked call.",
    ),
  );
  const right = el("div", "stack");
  const review = card([
    el("span", "cap", "Automatic review"),
    el(
      "p",
      "hint",
      "Automatic review is a Phase 5 surface. Until then every destructive call parks on the conversation and waits for a person.",
    ),
  ]);
  const source = card([
    el("span", "cap", "Where these come from"),
    el(
      "p",
      "hint",
      "An Always allow answer writes a rule. Rules written in a Bot's soul stay separate, because one is what you want and the other is what you once permitted.",
    ),
  ]);
  right.append(review, source);
  const grid = el("div", "grid-side");
  grid.append(left, right);
  return pageShell("Rules and the approvals ledger", "Page 13", [backButton(onLeave)], [grid]);
}

function activityPage(
  runs: readonly ActivityRun[],
  botFilter: string,
  statusFilter: string,
  onLeave: () => void,
  onFilter: (bot: string, status: string) => void,
): HTMLElement {
  const botNames = ["all", ...new Set(runs.map((run) => run.botName))];
  const statuses = ["all", "succeeded", "failed", "cancelled", "waiting", "running"];
  const filterRow = el("div", "row");
  filterRow.style.flexWrap = "wrap";
  filterRow.style.marginBottom = "16px";

  const botSeg = el("div", "seg");
  for (const name of botNames) {
    const button = el(
      "button",
      botFilter === name ? "is-active" : "",
      name === "all" ? "All Bots" : name,
    );
    button.type = "button";
    button.addEventListener("click", () => onFilter(name, statusFilter));
    botSeg.append(button);
  }
  const statusSeg = el("div", "seg");
  for (const name of statuses) {
    const button = el("button", statusFilter === name ? "is-active" : "", name);
    button.type = "button";
    button.addEventListener("click", () => onFilter(botFilter, name));
    statusSeg.append(button);
  }
  filterRow.append(botSeg, statusSeg);

  const rows = runs.filter(
    (run) =>
      (botFilter === "all" || run.botName === botFilter) &&
      (statusFilter === "all" || run.status === statusFilter),
  );
  const body: HTMLElement[] = [filterRow];
  if (rows.length === 0) {
    body.push(
      emptyState(
        "No runs match those filters",
        "Start a run from a conversation, or relax one of the filters.",
      ),
    );
  } else {
    const list = el("div", "listcard");
    for (const run of rows) {
      const row = el("div", "listrow");
      const when = new Date(run.startedAt).toLocaleString();
      const dot = el(
        "span",
        `dot${run.status === "succeeded" ? " on" : run.status === "failed" || run.status === "cancelled" ? " ring" : ""}`,
      );
      const copy = el("span", "grow");
      copy.append(el("span", "", run.botName));
      copy.lastElementChild?.setAttribute("style", "display:block;font-size:14px");
      copy.append(el("span", "hint truncate", `${when} · ${run.prompt}`));
      copy.lastElementChild?.setAttribute("style", "display:block");
      const meta = el("span", "row");
      meta.append(
        dot,
        el("span", "mono fs-meta muted", run.status),
        el("span", "mono fs-meta muted", run.runId),
      );
      row.append(copy, meta);
      list.append(row);
    }
    body.push(list);
  }
  return pageShell(
    "Activity log",
    "Page 17 · every run this install holds",
    [backButton(onLeave)],
    body,
  );
}

function teamsPage(onLeave: () => void): HTMLElement {
  const body: HTMLElement[] = [
    emptyState(
      "No team on this install",
      "Every Bot and every rule already carries an owner, so a team edition is a filter over owners rather than a new model. This build holds no team record, so there is nothing to list.",
    ),
  ];
  const note = el("p", "hint");
  note.style.marginTop = "26px";
  note.textContent =
    "The export's member rows, policies and audit card are a preview of Phase 5 and 7. The routes and records they would read do not exist yet.";
  body.push(note);
  return pageShell("Teams", "Page 18 · phase 5 and 7", [backButton(onLeave)], body);
}

function settingsPage(
  provider: ProviderConnection | null,
  pane: SettingsPane,
  settings: DisplaySettings,
  callbacks: {
    onPane: (pane: SettingsPane) => void;
    onOpenProvider: () => void;
    onSettings: (next: DisplaySettings) => void;
  },
): HTMLElement {
  const nav = el("div", "stack");
  nav.style.width = "200px";
  nav.style.flex = "none";
  for (const entry of SETTINGS_PANES) {
    const button = el("button", `sb-row${pane === entry.id ? " is-active" : ""}`);
    button.type = "button";
    button.append(icon(entry.icon), el("span", "name", entry.label));
    button.addEventListener("click", () => callbacks.onPane(entry.id));
    nav.append(button);
  }
  const content = el("div", "grow");
  content.style.paddingLeft = "22px";
  content.append(settingsPaneBody(provider, pane, settings, callbacks));

  const row = el("div", "row");
  row.style.alignItems = "flex-start";
  row.style.gap = "0";
  row.append(nav, content);

  const side = el("div", "stack");
  side.append(
    card([
      el("span", "cap", "Install"),
      kv("Version", "local build"),
      kv("Mode", "local"),
      kv("Vault", "~/.freebot/provider.env"),
    ]),
    card([
      el("span", "cap", "Provider"),
      kv("Model", provider?.model ?? "none"),
      kv("Tested", provider?.status === "capable" ? "yes" : "no"),
    ]),
  );

  const grid = el("div", "grid-side");
  grid.append(row, side);
  return pageShell(
    "Settings",
    "Page 14",
    [actionButton("Manage connections", "cpu", callbacks.onOpenProvider, "btn-secondary")],
    [grid],
  );
}

function settingsPaneBody(
  provider: ProviderConnection | null,
  pane: SettingsPane,
  settings: DisplaySettings,
  callbacks: {
    onOpenProvider: () => void;
    onSettings: (next: DisplaySettings) => void;
  },
): HTMLElement {
  const body = el("div", "stack");
  if (pane === "providers") {
    const connected = provider !== null;
    const cardNode = el("div", "card");
    const head = el("div", "row-between");
    const names = el("div");
    const titleRow = el("div", "row");
    titleRow.append(
      el("span", "", connected ? "Active connection" : "No connection"),
      connected
        ? tag(provider.status, provider.status === "capable" ? "solid" : "dim")
        : tag("empty", "dim"),
    );
    names.append(titleRow);
    if (connected) {
      const meta = el("div", "meta-row");
      meta.style.marginTop = "6px";
      meta.append(
        el("span", "mono", provider.baseUrl),
        el("span", "", "·"),
        el("span", "mono", provider.model),
      );
      names.append(meta);
    }
    head.append(names);
    cardNode.append(head);
    if (connected) {
      const flags = el("div", "stack");
      flags.style.marginTop = "12px";
      flags.append(
        kv("Tool calling", provider.flags?.toolCalling ?? "not tested"),
        kv("Structured output", provider.flags?.structuredOutput === true ? "yes" : "not needed"),
        kv("Streaming", provider.flags?.streaming === true ? "yes" : "no"),
      );
      cardNode.append(flags);
    } else {
      cardNode.append(
        el(
          "p",
          "hint",
          "A FreeBot install can hold a provider connection. Connect one to run a real model instead of the committed replay.",
        ),
      );
    }
    const actions = el("div", "row");
    actions.style.marginTop = "14px";
    actions.append(actionButton("Open the provider page", "cpu", callbacks.onOpenProvider));
    cardNode.append(actions);
    body.append(el("span", "cap", "Connections"), cardNode);
    const note = el("p", "hint");
    note.textContent =
      "One active connection. The provider page tests a real tool call before it saves the key.";
    body.append(note);
    return body;
  }

  if (pane === "general") {
    body.append(el("span", "cap", "Appearance and locale"));
    body.append(
      segmented("Theme", ["dark", "light", "system"], settings.theme, (value) =>
        callbacks.onSettings({ ...settings, theme: value as DisplaySettings["theme"] }),
      ),
      segmented("Accent", ["monochrome", "system blue"], settings.accent, (value) =>
        callbacks.onSettings({ ...settings, accent: value as DisplaySettings["accent"] }),
      ),
    );
    const note = el("p", "hint");
    note.textContent =
      "The appearance preference is kept in this browser. This build ships the export's dark token set, so light and system record the choice without changing the palette yet.";
    body.append(note);
    return body;
  }

  if (pane === "computer") {
    body.append(
      card([
        el("span", "cap", "This machine"),
        el(
          "p",
          "hint",
          "A run gets its own container and the container is removed when the run ends. The durable area is the Bot's /workspace, mounted into every run.",
        ),
      ]),
    );
    return body;
  }

  if (pane === "usage") {
    body.append(
      card([
        el("span", "cap", "This run's cap"),
        el(
          "p",
          "hint",
          "The run loop consults FREEBOT_SPEND_CAP_USD before every provider turn. This page has no usage record to chart yet, so it reports the rule rather than a number.",
        ),
      ]),
    );
    return body;
  }

  if (pane === "notifications") {
    for (const [id, label, description] of [
      ["approvals", "Approvals", "A Bot is waiting on a decision."],
      ["routines", "Routine results", "A scheduled run finished or failed."],
      ["finishes", "Run finishes", "Any run reaches a terminal state."],
      ["replies", "Bot replies", "A Bot answers outside a run you started."],
      ["voice", "Voice memos", "A Bot leaves a spoken note."],
    ] as const) {
      const row = el("div", "row-between");
      row.style.padding = "10px 0";
      row.style.borderBottom = "1px solid var(--border)";
      const copy = el("span");
      copy.append(el("span", "fs-meta", label), el("span", "hint", description));
      copy.lastElementChild?.setAttribute("style", "display:block");
      const toggle = el("button", `sw${settings.notify[id] ? " on" : ""}`);
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(settings.notify[id]));
      toggle.setAttribute("aria-label", label);
      toggle.append(el("i"));
      toggle.addEventListener("click", () =>
        callbacks.onSettings({
          ...settings,
          notify: { ...settings.notify, [id]: !settings.notify[id] },
        }),
      );
      row.append(copy, toggle);
      body.append(row);
    }
    const note = el("p", "hint");
    note.textContent =
      "These preferences are kept in this browser. The notification transport is later than this build.";
    body.append(note);
    return body;
  }

  if (pane === "updates") {
    body.append(
      card([
        el("span", "cap", "Channel"),
        el(
          "p",
          "hint",
          "This is a local build. Updates are a self-host operation today; there is no auto-update channel to choose.",
        ),
      ]),
    );
    return body;
  }

  body.append(
    card([
      el("span", "cap", "Danger zone"),
      el("p", "", "Delete all data"),
      el(
        "p",
        "hint",
        "Goes: every Bot, every thread, every run and its frames, rules, routines, secrets, and the local vault key. Survives: files under /workspace, and anything you exported.",
      ),
      actionButton("Delete all data", "warn", () => undefined, "btn-ghost", true),
    ]),
  );
  return body;
}

function segmented(
  label: string,
  options: readonly string[],
  current: string,
  onPick: (value: string) => void,
): HTMLElement {
  const field = el("div");
  field.style.marginBottom = "12px";
  field.append(el("label", "hint", label));
  const seg = el("div", "seg");
  for (const option of options) {
    const button = el("button", current === option ? "is-active" : "", option);
    button.type = "button";
    button.addEventListener("click", () => onPick(option));
    seg.append(button);
  }
  field.append(seg);
  return field;
}

function mobilePage(bot: Bot | null, onLeave: () => void): HTMLElement {
  const name = bot?.name ?? "FreeBot";
  const role = bot?.role ?? "Your Bot";
  const phones = el("div", "phones");
  phones.append(phoneList(name), phoneThread(name), phoneProfile(name, role));
  const note = el("p", "hint");
  note.style.marginTop = "28px";
  note.style.maxWidth = "70ch";
  note.textContent =
    "The screen is the Bot list, the conversation, and the Bot profile. No right pane. A thread opened on one surface is the same thread on the other. Push notifications and the native shells are Phase 6; this page is the layout preview the export carries.";
  return pageShell(
    "Mobile and the second surface",
    "Page 19 · phase 6",
    [backButton(onLeave)],
    [phones, note],
  );
}

function phoneList(name: string): HTMLElement {
  const phone = el("div", "phone");
  const screen = el("div", "screen");
  const bar = el("div", "pbar");
  bar.append(el("span", "", "9:41"), el("span", "", "5G"));
  const body = el("div", "pbody");
  const head = el("div", "row-between");
  head.style.padding = "4px 0 10px";
  head.append(el("span", "", "Bots"), el("span", "row", "Search / +"));
  body.append(head);
  for (const rowName of ["Atlas", name]) {
    const row = el("div", "sb-row");
    row.style.background = "transparent";
    row.append(el("span", "dot"), el("span", "name", rowName), el("span", "sub", "Bot"));
    body.append(row);
  }
  screen.append(bar, body);
  phone.append(screen);
  return phone;
}

function phoneThread(name: string): HTMLElement {
  const phone = el("div", "phone");
  const screen = el("div", "screen");
  const bar = el("div", "pbar");
  bar.append(el("span", "", "9:41"), el("span", "", "5G"));
  const body = el("div", "pbody");
  const head = el("div", "row-between");
  head.style.padding = "4px 0 10px";
  head.append(el("span", "", name), el("span", "", "···"));
  const message = el("div", "message user");
  message.style.maxWidth = "100%";
  message.style.marginBottom = "10px";
  message.append(el("p", "", "What changed in the sandbox since the last release?"));
  const reply = el(
    "p",
    "hint",
    "Two changes that matter. The transcript is the same thread you see on the desktop.",
  );
  body.append(head, message, reply);
  screen.append(bar, body);
  phone.append(screen);
  return phone;
}

function phoneProfile(name: string, role: string): HTMLElement {
  const phone = el("div", "phone");
  const screen = el("div", "screen");
  const bar = el("div", "pbar");
  bar.append(el("span", "", "9:41"), el("span", "", "5G"));
  const body = el("div", "pbody");
  body.append(el("div", "row-between", "Profile"));
  const identity = el("div", "row");
  identity.style.margin = "12px 0";
  identity.append(
    el("span", "avatar", name.slice(0, 2).toUpperCase()),
    el("span", `${name} · ${role}`),
  );
  body.append(
    identity,
    kv("Notifications", "on"),
    kv("Computer", "per run"),
    kv("Routines", "0"),
    kv("Memory", "0 rows"),
  );
  screen.append(bar, body);
  phone.append(screen);
  return phone;
}

function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element ${selector}`);
  return found;
}
