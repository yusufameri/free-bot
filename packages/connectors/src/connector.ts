/**
 * The connector seam: what a caller above a connector needs, and nothing about how one is wired.
 *
 * MCP is the wire and a vendor is one adapter behind this file. Plan Part 4 fixes the shape of the
 * four operations and Part 11 fixes credential custody: the app may name a credential (`TokenRef`)
 * and never holds its value, and a connector's credential never enters the sandbox. A caller
 * therefore sees a connector and no vendor type at all, which is what lets U8.3 add the Composio
 * adapter, and the gate-8 contract test delete it again, without a caller noticing.
 *
 * `boundary.test.ts` enforces the "no vendor above the adapter" half of that promise over this
 * package's own source, so the rule is a failing test rather than a convention.
 */

/** One tool a connector offers, in the shape a model-facing tool list needs. */
export interface ConnectorTool {
  readonly name: string;
  readonly description: string;
  /** The JSON Schema for the tool's arguments, passed through from the wire unread. */
  readonly parameters: Record<string, unknown>;
}

/** What one call returned: the text the model reads, and whether the tool called it a failure. */
export interface ConnectorResult {
  readonly ok: boolean;
  readonly output: string;
}

/** What a probe found. `detail` is safe to show and carries no credential. */
export interface ConnectorHealth {
  readonly ok: boolean;
  readonly detail: string;
}

declare const tokenRefBrand: unique symbol;

/**
 * A credential reference. It names which credential a connector uses and never carries it, so a
 * shape that has to describe a connection can do so without holding the secret.
 */
export type TokenRef = string & { readonly [tokenRefBrand]: true };

export function tokenRef(name: string): TokenRef {
  return name as TokenRef;
}

/**
 * The reference an app-held connector's credential carries. The app names a credential after the
 * connector's own id, so one spelling of the name lives here rather than in every row that shows it.
 */
export function connectorRef(id: string): TokenRef {
  return tokenRef(`connector:${id}`);
}

/**
 * Where a connector's credential comes from. `headers()` is read at call time, so a credential
 * rotated in place needs no rebuild, and what it returns reaches one request header and no log, no
 * artifact and no response body. U8.2 supplies the vault-backed implementation; this unit's
 * harness supplies a file-backed one.
 */
export interface CredentialSource {
  readonly ref: TokenRef;
  headers(): Record<string, string>;
}

/**
 * The name a connector's tool carries in a model-facing tool list. A connector's own names are its
 * server's, so two connectors can both offer `create_issue`; the id in front is what keeps the two
 * apart in the list the model reads and in the ledger the gate writes.
 */
export function namespacedToolName(connectorId: string, toolName: string): string {
  return `${connectorId}__${toolName}`;
}

/** A connector that cannot be reached, or that answered something this seam cannot use. */
export class ConnectorError extends Error {
  readonly connectorId: string;

  constructor(connectorId: string, detail: string) {
    super(`connector ${connectorId}: ${detail}`);
    this.name = "ConnectorError";
    this.connectorId = connectorId;
  }
}

/** One connector's tool as the model reads it: the namespaced name, and what to call underneath. */
export interface OfferedTool {
  /** The name the model is offered, from `namespacedToolName`. */
  readonly name: string;
  readonly connectorId: string;
  /** The connector's own name for the tool, which is what `call` takes. */
  readonly tool: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/**
 * The tools one connector contributes to a run. Discovery is the connector's, not the caller's, so a
 * tool the person's server gained since the last run appears at the next one.
 */
export async function offeredTools(connector: Connector): Promise<readonly OfferedTool[]> {
  const tools = await connector.describe();
  return tools.map((tool) => ({
    name: namespacedToolName(connector.id, tool.name),
    connectorId: connector.id,
    tool: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * One connector. A model-facing tool needs three of these: the tools to offer, the call to run, and
 * a health probe a surface can render. `authenticate` is the fourth: it probes with the person's
 * own credential and answers with a `TokenRef` rather than a token, which is what a sign-in surface
 * needs and all it may see.
 */
export interface Connector {
  /** The app's own handle for this connector. It namespaces tool names and is what a route lists. */
  readonly id: string;
  /** The credential this connector uses, as a reference. A caller may show it and cannot spend it. */
  readonly ref: TokenRef;
  describe(): Promise<readonly ConnectorTool[]>;
  authenticate(): Promise<TokenRef>;
  call(tool: string, args: unknown): Promise<ConnectorResult>;
  health(): Promise<ConnectorHealth>;
}
