/**
 * The app's connectors: two files under the freebot home, one secret and one not.
 *
 * A connector's endpoint and its label are not secrets, so they live in the record file a route
 * answers from (`connectors.json`, mode 600). Its credential is the person's own, so it lives in the
 * vault beside it (`connectors.env`, mode 600) through the same `vault.ts` writer the BYOK key uses.
 * Nothing in the record file holds a header value, and a record that carries one is refused by name
 * at boot rather than loading a connector nobody can authenticate.
 *
 * The connector a call goes through is built from the vault, and its `headers()` reads the vault at
 * call time, so replacing a credential changes what the next request carries with no rebuild and no
 * restart. That property is the reason `ConnectorRef` and `CredentialSource` exist in the seam.
 *
 * A connector's state is one of three words rather than a boolean: `connected` and `unreachable` are
 * what a probe of the person's own service found, and `untested` is a record the vault holds no
 * credential for. The third is what keeps a missing credential from reading as a broken service.
 */

import { basename, dirname, join } from "node:path";
import {
  type Connector,
  type ConnectorTool,
  connectorRef,
  McpConnector,
  type TokenRef,
  tokenRef,
} from "@freebot/connectors";
import type { ConnectConnectorInput, ConnectorState } from "@freebot/protocol";
import { connectorStateSchema, connectorToolSchema } from "@freebot/protocol";
import {
  freebotHome,
  readPrivateFile,
  secretLines,
  writePrivateFile,
  writeSecretFile,
} from "./vault.ts";

/** The record file a person's connectors live in, beside the vault under the freebot home. */
export const CONNECTORS_FILE = "connectors.json";

/** The vault file their credentials live in, beside the record and under the same mode. */
export const CONNECTOR_VAULT_FILE = "connectors.env";

/** The vault line a connector's credential lives on: its own id, after this prefix. */
const CREDENTIAL_PREFIX = "FREEBOT_CONNECTOR_";

/** The two files one set of connectors lives in. */
export interface ConnectorPaths {
  /** The non-secret half: which connectors exist, where they are, and what the last probe found. */
  readonly record: string;
  /** The secret half: one `FREEBOT_CONNECTOR_<id>` line per connector, mode 600. */
  readonly vault: string;
}

export function connectorPaths(
  env: Record<string, string | undefined> = process.env,
): ConnectorPaths {
  const home = freebotHome(env);
  return { record: join(home, CONNECTORS_FILE), vault: join(home, CONNECTOR_VAULT_FILE) };
}

/**
 * The pair a `--connectors <record>` path names: the record, and the vault beside it, which is the
 * record's own name with `.env` for its extension. One flag on the command line therefore still
 * names one set of connectors, and an evidence driver pointed at its own temp home gets that home's
 * credential file rather than the machine's.
 */
export function pathsBeside(record: string): ConnectorPaths {
  const name = basename(record).replace(/\.[^./]*$/, "");
  return { record, vault: join(dirname(record), `${name}.env`) };
}

/** One connector's credential: the headers its own server asks for, and nothing else. */
export type ConnectorCredential = Readonly<Record<string, string>>;

/** Every credential the vault holds, by connector id. */
export type ConnectorCredentials = ReadonlyMap<string, ConnectorCredential>;

/**
 * One connector's non-secret half, as the record file holds it and as a route answers it.
 *
 * `ref` names the credential and cannot carry it. `state` and `detail` are the last probe's outcome
 * in the probe's own words; `testedAt` is when it ran, or null for a record never probed.
 */
export interface ConnectorRecord {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly ref: TokenRef;
  readonly state: ConnectorState;
  readonly detail: string;
  readonly testedAt: number | null;
  readonly tools: readonly ConnectorTool[];
}

/** A record file that is there and cannot be read as connector records. */
export class ConnectorFileError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "ConnectorFileError";
    this.path = path;
  }
}

/** A connector id no record holds. The route reports it as a refusal, not as an unhealthy row. */
export class UnknownConnectorError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`no such connector: ${id}`);
    this.name = "UnknownConnectorError";
    this.id = id;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The record file: which connectors exist, and what the last probe found
// ---------------------------------------------------------------------------

/**
 * Read the record file's own shape at the boundary, so a typo is a boot failure by name and not a
 * silent zero. An absent file is the ordinary no-connectors machine, and `readConnectorRecords`
 * turns that into the empty list.
 *
 * A `headers` field is the one refusal this parser names specifically: that is the shape the file had
 * before the credential moved to the vault, and a record still carrying one would otherwise read as
 * a connector with no credential at all.
 */
export function parseConnectorRecords(text: string, paths: ConnectorPaths): ConnectorRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConnectorFileError(paths.record, `not JSON: ${messageOf(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.connectors)) {
    throw new ConnectorFileError(paths.record, 'expected an object with a "connectors" array');
  }
  const seen = new Set<string>();
  return parsed.connectors.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ConnectorFileError(paths.record, `connectors[${index}] is not an object`);
    }
    const { id, label, url, ref, state, detail, testedAt, tools, headers } = raw;
    if (typeof id !== "string" || id.length === 0) {
      throw new ConnectorFileError(
        paths.record,
        `connectors[${index}].id must be a non-empty string`,
      );
    }
    if (headers !== undefined) {
      throw new ConnectorFileError(
        paths.record,
        `connector ${id}: a credential does not belong in this file, it lives in ${paths.vault} at mode 600`,
      );
    }
    if (typeof url !== "string" || !url.startsWith("http")) {
      throw new ConnectorFileError(paths.record, `connector ${id}: url must be an http(s) URL`);
    }
    if (seen.has(id)) {
      throw new ConnectorFileError(paths.record, `connector ${id}: two records hold this id`);
    }
    seen.add(id);
    return {
      id,
      label: typeof label === "string" && label.length > 0 ? label : id,
      url,
      ref: typeof ref === "string" && ref.length > 0 ? tokenRef(ref) : connectorRef(id),
      state: parseState(state, id, paths),
      detail: typeof detail === "string" ? detail : "",
      testedAt:
        typeof testedAt === "number" && Number.isInteger(testedAt) && testedAt > 0
          ? testedAt
          : null,
      tools: parseTools(tools, id, paths),
    };
  });
}

function parseState(state: unknown, id: string, paths: ConnectorPaths): ConnectorState {
  if (state === undefined) return "untested";
  const shaped = connectorStateSchema.safeParse(state);
  if (!shaped.success) {
    throw new ConnectorFileError(
      paths.record,
      `connector ${id}: state must be one of ${connectorStateSchema.options.join(", ")}`,
    );
  }
  return shaped.data;
}

function parseTools(tools: unknown, id: string, paths: ConnectorPaths): ConnectorTool[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) {
    throw new ConnectorFileError(paths.record, `connector ${id}: tools must be an array`);
  }
  return tools.map((tool, index) => {
    const shaped = connectorToolSchema.safeParse(tool);
    if (!shaped.success) {
      throw new ConnectorFileError(
        paths.record,
        `connector ${id}: tools[${index}] is not a tool this seam offers`,
      );
    }
    return shaped.data;
  });
}

/** The records of a connectors file. An absent file is the no-connectors machine, not an error. */
export function readConnectorRecords(paths: ConnectorPaths): ConnectorRecord[] {
  const text = readPrivateFile(paths.record);
  return text === null ? [] : parseConnectorRecords(text, paths);
}

export function writeConnectorRecords(
  records: readonly ConnectorRecord[],
  paths: ConnectorPaths,
): void {
  const file = {
    connectors: records.map((record) => ({
      id: record.id,
      label: record.label,
      url: record.url,
      ref: record.ref,
      state: record.state,
      detail: record.detail,
      testedAt: record.testedAt,
      tools: record.tools,
    })),
  };
  writePrivateFile(paths.record, `${JSON.stringify(file, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// The vault: the credential, and nothing that reads it back out
// ---------------------------------------------------------------------------

/** Every credential line of the vault as the file holds it, keyed by the id the line names. */
function credentialLines(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of secretLines(text)) {
    if (!line.name.startsWith(CREDENTIAL_PREFIX)) continue;
    found.set(line.name.slice(CREDENTIAL_PREFIX.length), `${line.name}=${line.value}`);
  }
  return found;
}

/**
 * Rewrite the vault from a set of lines, sorted by id, so the same set of credentials always
 * produces the same file. The whole file is rewritten because the format is one line per connector:
 * writing one credential means re-emitting the rest, and the reader is the seam, never a route.
 */
function writeCredentialLines(paths: ConnectorPaths, lines: ReadonlyMap<string, string>): void {
  const ordered = [...lines.entries()].sort(([left], [right]) => left.localeCompare(right));
  writeSecretFile(paths.vault, [
    "# freebot's connector vault. Written by the app's connector routes and read by the seam alone.",
    ...ordered.map(([, line]) => line),
  ]);
}

/**
 * The vault's shape at the boundary: one `FREEBOT_CONNECTOR_<id>` line per connector, whose value is
 * the JSON of that connector's header map. A line this app cannot read is a named failure rather
 * than a connector that silently probes with no credential.
 */
export function parseConnectorCredentials(
  text: string,
  path: string,
): Map<string, ConnectorCredential> {
  const found = new Map<string, ConnectorCredential>();
  for (const line of secretLines(text)) {
    if (!line.name.startsWith(CREDENTIAL_PREFIX)) continue;
    const id = line.name.slice(CREDENTIAL_PREFIX.length);
    if (id.length === 0) throw new ConnectorFileError(path, `${line.name} names no connector`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.value);
    } catch {
      throw new ConnectorFileError(path, `${line.name} is not the JSON of a header map`);
    }
    if (!isRecord(parsed)) {
      throw new ConnectorFileError(path, `${line.name} is not the JSON of a header map`);
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new ConnectorFileError(path, `${line.name}: header ${name} is not a string`);
      }
      headers[name] = value;
    }
    found.set(id, headers);
  }
  return found;
}

/** Every credential the vault holds. An absent vault is the no-credentials machine. */
export function readConnectorCredentials(paths: ConnectorPaths): Map<string, ConnectorCredential> {
  const text = readPrivateFile(paths.vault);
  return text === null ? new Map() : parseConnectorCredentials(text, paths.vault);
}

/** Save one connector's credential, replacing any the vault already held for that id. */
export function writeConnectorCredential(
  paths: ConnectorPaths,
  id: string,
  headers: ConnectorCredential,
): void {
  const text = readPrivateFile(paths.vault);
  const lines = text === null ? new Map<string, string>() : credentialLines(text);
  lines.set(id, `${CREDENTIAL_PREFIX}${id}=${JSON.stringify(headers)}`);
  writeCredentialLines(paths, lines);
}

/** Take one connector's credential out of the vault. Answers whether there was one to take. */
export function removeConnectorCredential(paths: ConnectorPaths, id: string): boolean {
  const text = readPrivateFile(paths.vault);
  if (text === null) return false;
  const lines = credentialLines(text);
  if (!lines.delete(id)) return false;
  writeCredentialLines(paths, lines);
  return true;
}

// ---------------------------------------------------------------------------
// The registry: the records, the probes, and the credentials the run path asks for
// ---------------------------------------------------------------------------

/**
 * The connectors one server holds, read from the two files on every call rather than cached.
 *
 * Nothing is kept in memory between calls, so a connect, a removal or a hand-edited file is what the
 * next call sees, and a run started after a connect is offered the connector that connect saved.
 * `boundary.test.ts` in `packages/connectors` is what keeps a vendor out of the layer underneath;
 * this class is the app's own reader of the person's two files.
 */
export class ConnectorRegistry {
  readonly #paths: ConnectorPaths;

  private constructor(paths: ConnectorPaths) {
    this.#paths = paths;
  }

  static open(paths: ConnectorPaths = connectorPaths()): ConnectorRegistry {
    return new ConnectorRegistry(paths);
  }

  /** The two files this registry reads and writes, so a caller can name them without guessing. */
  get paths(): ConnectorPaths {
    return this.#paths;
  }

  /**
   * The connectors themselves, which is what the run path needs for its tool arms. A record the
   * vault holds no credential for is left out: a tool arm that can only ever be refused is worse
   * than a connector that is not offered, and the route's row is where that state is shown.
   */
  connectors(): readonly Connector[] {
    const credentials = readConnectorCredentials(this.#paths);
    return readConnectorRecords(this.#paths)
      .filter((record) => credentials.has(record.id))
      .map((record) => this.#connectorFor(record));
  }

  /** Ids, labels and addresses only: a boot line may say this much and never a credential. */
  describe(): Array<{ id: string; label: string; url: string }> {
    return readConnectorRecords(this.#paths).map(({ id, label, url }) => ({ id, label, url }));
  }

  /**
   * Every connector as a row, probed once each. A connector that does not answer is a row in the
   * `unreachable` state, because a surface that lists connectors has to show the broken one. A read
   * records nothing: the store's own copy of a state is what the last connect or test saved.
   */
  async list(): Promise<ConnectorRecord[]> {
    const credentials = readConnectorCredentials(this.#paths);
    return await Promise.all(
      readConnectorRecords(this.#paths).map(
        async (record) => await this.#probe(record, credentials),
      ),
    );
  }

  /**
   * The probe a person runs when they add or check a connector: does this connector's own service
   * accept the credential, and what does it offer. A refusal is a successful call whose answer says
   * so, and the outcome is what this connector's row holds from now on.
   */
  async test(id: string): Promise<ConnectorRecord> {
    const record = readConnectorRecords(this.#paths).find((candidate) => candidate.id === id);
    if (record === undefined) throw new UnknownConnectorError(id);
    return this.#save(await this.#probe(record));
  }

  /**
   * Connect a connector, or replace the credential of one this install already holds. The credential
   * is saved first and the record second, so a connection the person's own service refuses is still
   * saved and shown as `unreachable`: a service that is down, or a credential that is wrong, is a
   * state a surface renders rather than a save that never happened.
   */
  async connect(input: ConnectConnectorInput): Promise<ConnectorRecord> {
    const existing = readConnectorRecords(this.#paths).find(
      (candidate) => candidate.id === input.id,
    );
    writeConnectorCredential(this.#paths, input.id, input.headers);
    this.#save({
      id: input.id,
      // Rotating a credential does not rename the connector: the label a person gave it stands.
      label: input.label ?? existing?.label ?? input.id,
      url: input.url,
      ref: connectorRef(input.id),
      state: "untested",
      detail: "",
      testedAt: null,
      tools: [],
    });
    return await this.test(input.id);
  }

  /**
   * Remove a connector: its credential leaves the vault and its record leaves the store, so a later
   * call for it is refused by name instead of finding a stale secret. Removing one this install does
   * not hold is not an error, which is what makes a second removal safe to send.
   */
  remove(id: string): { id: string; removed: boolean } {
    const records = readConnectorRecords(this.#paths);
    const held = records.some((candidate) => candidate.id === id);
    removeConnectorCredential(this.#paths, id);
    writeConnectorRecords(
      records.filter((candidate) => candidate.id !== id),
      this.#paths,
    );
    return { id, removed: held };
  }

  /**
   * One connector over the credential the vault holds for it. `headers()` reads the vault on every
   * request rather than capturing a value, which is what lets a credential replaced in place reach
   * the next call with no rebuild, no restart and no second connector.
   */
  #connectorFor(record: ConnectorRecord): Connector {
    return new McpConnector({
      id: record.id,
      url: record.url,
      credential: {
        ref: record.ref,
        headers: () => readConnectorCredentials(this.#paths).get(record.id) ?? {},
      },
    });
  }

  /**
   * One probe: the sign-in through the seam, then the tool listing. The credential is read from the
   * vault at call time, so this is the person's own service answering about the person's own
   * credential, and the answer's own words become the row's detail.
   */
  async #probe(
    record: ConnectorRecord,
    credentials?: ConnectorCredentials,
  ): Promise<ConnectorRecord> {
    const held = credentials ?? readConnectorCredentials(this.#paths);
    if (!held.has(record.id)) {
      return {
        ...record,
        state: "untested",
        detail: `no credential in ${this.#paths.vault} for ${record.ref}`,
        testedAt: null,
        tools: [],
      };
    }
    const connector = this.#connectorFor(record);
    try {
      const ref = await connector.authenticate();
      const tools = await connector.describe();
      return {
        ...record,
        state: "connected",
        detail: `${ref} accepted, ${tools.length} tools`,
        testedAt: Date.now(),
        tools,
      };
    } catch (error) {
      return {
        ...record,
        state: "unreachable",
        detail: messageOf(error),
        testedAt: Date.now(),
        tools: [],
      };
    }
  }

  /** Replace one record in the store, or append it, and answer the store's own copy. */
  #save(record: ConnectorRecord): ConnectorRecord {
    const records = readConnectorRecords(this.#paths);
    const next = records.some((candidate) => candidate.id === record.id)
      ? records.map((candidate) => (candidate.id === record.id ? record : candidate))
      : [...records, record];
    writeConnectorRecords(next, this.#paths);
    return record;
  }
}
