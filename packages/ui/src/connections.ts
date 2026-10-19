/**
 * The Connect apps model: what one connector record renders as, in the words the screen and the
 * evidence both read.
 *
 * `packages/ui/browser/connect-apps.ts` decides nothing. It turns these rows, state lines and
 * failure controls into nodes, the split `provider.ts` keeps with its page.
 *
 * Three states, not five. A record carries `connected`, `unreachable` and `untested`, and each one
 * has its own sentence and at most one failure control. The export's other two states, and the
 * controls that need records this install does not hold, are named in `CONNECTOR_DELTAS` so the
 * screen can say what it does not carry instead of faking a row.
 */

import type { ConnectorRow, ConnectorState, ConnectorToolRow } from "@freebot/protocol";

export const CONNECT_APPS_TITLE = "Apps and connectors";
export const CONNECT_APPS_EYEBROW = "Gallery · page 12";

export const CONNECT_APPS_EMPTY_TITLE = "No apps connected";
export const CONNECT_APPS_EMPTY_BODY =
  "A connector is a tool a Bot can call on your own service. Add one with its endpoint and credential, and this screen holds its state and the tools its own server offers.";

export const ADD_LABEL = "Add a connection";
export const ADD_TITLE = "Add a connection";
export const ADD_EYEBROW = "App · connect";

export const CONNECTOR_NAME_LABEL = "Name";
export const CONNECTOR_NAME_PLACEHOLDER = "Notes service";
export const CONNECTOR_URL_LABEL = "Endpoint";
export const CONNECTOR_URL_PLACEHOLDER = "https://your-service.example/mcp";
export const CONNECTOR_HEADER_NAME_LABEL = "Header";
export const CONNECTOR_HEADER_NAME_PLACEHOLDER = "authorization";
export const CONNECTOR_HEADER_VALUE_LABEL = "Credential";
export const CONNECTOR_HEADER_VALUE_PLACEHOLDER = "never read back, never logged";
export const ADD_SAVE_LABEL = "Save and test";
export const CANCEL_LABEL = "Cancel";

export const CREDENTIAL_NOTE =
  "The credential goes to the vault at mode 600. This screen never reads it back, and no route returns it.";
export const HEADER_NOTE =
  "The header your own server asks for. Most MCP servers take authorization with a bearer value, and the endpoint field takes the URL of your MCP server.";

export const CONNECTED_LABEL = "Connected";
export const UNREACHABLE_LABEL = "Unreachable";
export const UNTESTED_LABEL = "Untested";

export const STATE_LABELS: Record<ConnectorState, string> = {
  connected: CONNECTED_LABEL,
  unreachable: UNREACHABLE_LABEL,
  untested: UNTESTED_LABEL,
};

export const STATE_LINES: Record<ConnectorState, string> = {
  connected:
    "The probe reached your own service and it answered. The tools listed here are what the next run is offered.",
  unreachable:
    "The probe ran and your service did not answer with anything this connector can use. The service's own words are under the details.",
  untested:
    "The vault holds no credential for this connector, so nothing was probed. This is not a broken service.",
};

export type ConnectorActionId = "test" | "retry" | "authorize" | "reconnect";

export interface ConnectorAction {
  readonly id: ConnectorActionId;
  readonly label: string;
  /** Why this control is the one this state offers, in one sentence. */
  readonly why: string;
}

const TEST_ACTION: ConnectorAction = {
  id: "test",
  label: "Test",
  why: "Ask your service again with the credential the vault holds, and re-read the tools it offers.",
};

const RETRY_ACTION: ConnectorAction = {
  id: "retry",
  label: "Retry",
  why: "The last probe did not get an answer this connector could use. Retry asks the same service again.",
};

const RECONNECT_ACTION: ConnectorAction = {
  id: "reconnect",
  label: "Reconnect",
  why: "Replace the credential in the vault and probe with the new one. The endpoint stays the same.",
};

const AUTHORIZE_ACTION: ConnectorAction = {
  id: "authorize",
  label: "Authorize",
  why: "The vault holds no credential, so there is nothing to probe. Authorize saves one and runs the probe.",
};

/**
 * The one failure control a state offers, or null when the state is healthy. The export names four
 * (`Authorize`, `Reconnect`, `Reopen`, `Retry`); two of them need records this install does not
 * hold, and `CONNECTOR_DELTAS` says which and why.
 */
export function failureAction(state: ConnectorState): ConnectorAction | null {
  switch (state) {
    case "connected":
      return null;
    case "unreachable":
      return RETRY_ACTION;
    case "untested":
      return AUTHORIZE_ACTION;
  }
}

/** Every control the detail page offers for one state, in the order it renders them. */
export function detailActions(state: ConnectorState): ConnectorAction[] {
  switch (state) {
    case "connected":
      return [TEST_ACTION];
    case "unreachable":
      return [RETRY_ACTION, RECONNECT_ACTION];
    case "untested":
      return [AUTHORIZE_ACTION, TEST_ACTION];
  }
}

/** Which states need the person's attention first: a broken connector outranks a healthy one. */
const STATE_RANK: Record<ConnectorState, number> = {
  unreachable: 0,
  untested: 1,
  connected: 2,
};

export interface ConnectionView {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** The credential's reference. It names the secret and cannot spend it. */
  readonly ref: string;
  readonly state: ConnectorState;
  readonly stateLabel: string;
  readonly stateLine: string;
  /** The last probe's own words, verbatim. Empty for a record nobody has probed. */
  readonly detail: string;
  readonly tools: readonly ConnectorToolRow[];
  readonly toolCount: number;
  readonly testedLine: string;
  readonly monogram: string;
  readonly failure: ConnectorAction | null;
}

/** When the last probe ran, in UTC so two machines read the same line. */
export function testedLine(testedAt: number | null): string {
  if (testedAt === null) return "Never tested";
  const stamp = new Date(testedAt).toISOString().slice(0, 16).replace("T", " ");
  return `Tested ${stamp} UTC`;
}

export function monogramOf(label: string): string {
  const letters = label.slice(0, 2).toUpperCase();
  return letters === "" ? "?" : letters;
}

export function connectionView(row: ConnectorRow): ConnectionView {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    ref: row.ref,
    state: row.state,
    stateLabel: STATE_LABELS[row.state],
    stateLine: STATE_LINES[row.state],
    detail: row.detail,
    tools: row.tools,
    toolCount: row.tools.length,
    testedLine: testedLine(row.testedAt),
    monogram: monogramOf(row.label),
    failure: failureAction(row.state),
  };
}

/** The gallery's order: states that need a person first, then by label. */
export function connectionViews(rows: readonly ConnectorRow[]): ConnectionView[] {
  return rows
    .map(connectionView)
    .sort(
      (left, right) =>
        STATE_RANK[left.state] - STATE_RANK[right.state] || left.label.localeCompare(right.label),
    );
}

export function connectionSummary(rows: readonly ConnectorRow[]): {
  readonly on: number;
  readonly attention: number;
  readonly total: number;
  readonly label: string;
} {
  const on = rows.filter((row) => row.state === "connected").length;
  return { on, attention: rows.length - on, total: rows.length, label: `${on} on` };
}

/**
 * The id a new connector takes. The record's id namespaces every tool name the connector offers,
 * so it is one slug, and a second connector with the same name takes the next free suffix rather
 * than rotating the first one's credential.
 */
export function connectorIdFrom(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "connector";
  const held = new Set(taken);
  if (!held.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, 60)}-${suffix}`;
    if (!held.has(candidate)) return candidate;
  }
}

export function addedLine(label: string, state: ConnectorState): string {
  return `Added ${label}. The probe answered ${STATE_LABELS[state]}.`;
}

export function testedResultLine(label: string, state: ConnectorState): string {
  return `Tested ${label}. The probe answered ${STATE_LABELS[state]}.`;
}

export function removedLine(label: string, removed: boolean): string {
  return removed
    ? `Removed ${label}. Its record and its credential are gone.`
    : `${label} was already gone.`;
}

export function savedCredentialLine(label: string, state: ConnectorState): string {
  return `Saved a credential for ${label}. The probe answered ${STATE_LABELS[state]}.`;
}

export interface ConnectorDelta {
  readonly title: string;
  readonly reason: string;
}

/**
 * What this screen cannot show, and the record field each one would need. Acceptance 4 asks for a
 * named delta rather than a fake row, and the same list lands in `docs/connectors.md`.
 */
export const CONNECTOR_DELTAS: readonly ConnectorDelta[] = [
  {
    title: "Composio adapter",
    reason:
      "The registry builds every record from its endpoint as an MCP connector, and a record has no adapter-kind field. A connector pointed at your own Composio MCP endpoint works here, and this screen cannot label it as the Composio adapter.",
  },
  {
    title: "The bash arm",
    reason:
      "bash is the run's sandbox tool, declared in the run's own tool table, and it is not a connector. This screen lists connector records, so bash has no row here.",
  },
  {
    title: "Five states in the export, three in the record",
    reason:
      "The record can say connected, unreachable or untested. Added but not signed in reads as Untested, and Disconnected reads as Unreachable. Needs auth and Disabled by team admin need record fields that do not exist.",
  },
  {
    title: "Reopen",
    reason:
      "There is no app catalog to reopen. A connector is a record in this install, so this screen is the way back to it.",
  },
  {
    title: "Accounts",
    reason:
      "The vault holds one credential line per connector. Add another account needs a record that names several, and it does not have one.",
  },
  {
    title: "Per-tool switches",
    reason:
      "Tools are listed as the server offered them. A switch needs a permission field on the record. Until then every connector tool is destructive and parks at the run's gate.",
  },
  {
    title: "Add secret",
    reason:
      "A Bot's named secrets are not a connector. The vault holds the provider key and one credential per connector, and no Bot secret record exists.",
  },
];

export interface ConnectAppsFacts {
  readonly view: "gallery" | "detail" | "add" | "closed";
  readonly title: string;
  readonly rows: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly state: string;
    readonly tag: string;
  }>;
  readonly empty: boolean;
  readonly detail: {
    readonly id: string;
    readonly label: string;
    readonly state: string;
    readonly line: string;
    readonly refused: string;
    readonly actions: readonly string[];
    readonly tools: readonly string[];
    readonly ref: string;
    readonly tested: string;
  } | null;
  readonly add: {
    readonly open: boolean;
    readonly credentialEmpty: boolean;
  } | null;
  /** The detail page's credential field, or null when that form is closed. */
  readonly credentialEmpty: boolean | null;
  readonly notice: string | null;
  readonly error: string | null;
  readonly deltas: readonly string[];
}
