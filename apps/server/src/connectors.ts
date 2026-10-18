/**
 * The app's connectors: the file a person writes, and the rows a route answers with.
 *
 * A connector's address and its credential are the person's own, so both live in one file under the
 * freebot home (`connectors.json`, beside the vault), never in the repo and never in the
 * environment. The file's `headers` are the credential: they reach one request header and nothing
 * else, which is why no row here carries them and no route can answer with them. U8.2 replaces this
 * file with the vault-backed flow and adds its three probes; the shape a caller sees is already the
 * shape U8.2 needs.
 *
 * A file that is present and unreadable fails at boot, by name, rather than silently loading no
 * connectors. A file that is absent is the ordinary state of a machine nobody has connected
 * anything on, and it loads zero.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Connector,
  ConnectorError,
  type ConnectorHealth,
  type ConnectorTool,
  McpConnector,
  tokenRef,
} from "@freebot/connectors";
import { freebotHome } from "./vault.ts";

/** The file a person's connectors live in, beside the vault under the freebot home. */
export const CONNECTORS_FILE = "connectors.json";

export function connectorsPath(env: Record<string, string | undefined> = process.env): string {
  return join(freebotHome(env), CONNECTORS_FILE);
}

/** One entry as the person wrote it. `headers` is the credential, and it stays in this record. */
export interface ConnectorEntry {
  readonly id: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** A connectors file that is there and cannot be read as connector entries. */
export class ConnectorFileError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "ConnectorFileError";
    this.path = path;
  }
}

/** A connector id no registry holds. The route reports it as a refusal, not as an unhealthy row. */
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

/** Read the file's own shape at the boundary, so a typo is a boot failure and not a silent zero. */
export function parseConnectors(text: string, path: string): ConnectorEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConnectorFileError(path, `not JSON: ${error instanceof Error ? error.message : ""}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.connectors)) {
    throw new ConnectorFileError(path, 'expected an object with a "connectors" array');
  }
  return parsed.connectors.map((raw, index) => {
    if (!isRecord(raw)) throw new ConnectorFileError(path, `connectors[${index}] is not an object`);
    const { id, url, headers } = raw;
    if (typeof id !== "string" || id.length === 0) {
      throw new ConnectorFileError(path, `connectors[${index}].id must be a non-empty string`);
    }
    if (typeof url !== "string" || !url.startsWith("http")) {
      throw new ConnectorFileError(path, `connector ${id}: url must be an http(s) URL`);
    }
    const parsedHeaders: Record<string, string> = {};
    if (headers !== undefined) {
      if (!isRecord(headers))
        throw new ConnectorFileError(path, `connector ${id}: headers must be an object`);
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== "string") {
          throw new ConnectorFileError(path, `connector ${id}: header ${name} must be a string`);
        }
        parsedHeaders[name] = value;
      }
    }
    return { id, url, headers: parsedHeaders };
  });
}

/** The entries of a connectors file. An absent file is the no-connectors machine, not an error. */
export function readConnectors(path: string): ConnectorEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw new ConnectorFileError(
      path,
      `cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseConnectors(text, path);
}

/** One connector as a surface reads it: where it is, what it offers, and whether it answers. */
export interface ConnectorRow {
  readonly id: string;
  readonly url: string;
  /** The credential's reference, never its value. */
  readonly ref: string;
  readonly tools: readonly ConnectorTool[];
  readonly health: ConnectorHealth;
}

export interface ConnectorTest {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly tools: readonly ConnectorTool[];
}

function messageOf(error: unknown): string {
  if (error instanceof ConnectorError || error instanceof Error) return error.message;
  return String(error);
}

/**
 * The connectors one server holds. Every connector is an `McpConnector` today, because MCP is the
 * wire; the registry is what a run asks for its tool arms and what the routes list, so U8.3 adds
 * another adapter here and nowhere above it.
 */
export class ConnectorRegistry {
  readonly #entries: readonly ConnectorEntry[];
  readonly #connectors: readonly Connector[];

  private constructor(entries: readonly ConnectorEntry[], connectors: readonly Connector[]) {
    this.#entries = entries;
    this.#connectors = connectors;
  }

  static fromEntries(entries: readonly ConnectorEntry[]): ConnectorRegistry {
    const connectors = entries.map(
      (entry) =>
        new McpConnector({
          id: entry.id,
          url: entry.url,
          credential: {
            ref: tokenRef(`connector:${entry.id}`),
            // Read at call time, and handed to this one object: it is the only holder of the value.
            headers: () => ({ ...entry.headers }),
          },
        }),
    );
    return new ConnectorRegistry(entries, connectors);
  }

  /** The registry a launcher builds from the person's file. */
  static fromFile(path: string): ConnectorRegistry {
    return ConnectorRegistry.fromEntries(readConnectors(path));
  }

  /** The connectors themselves, which is what the run path needs for its tool arms. */
  connectors(): readonly Connector[] {
    return this.#connectors;
  }

  /** Ids and addresses only: a boot line may say this much and never a header. */
  describe(): Array<{ id: string; url: string }> {
    return this.#entries.map((entry) => ({ id: entry.id, url: entry.url }));
  }

  /**
   * Every connector as a row, probed once each. A connector that does not answer is a row with
   * `ok: false` and no tools, because a surface that lists connectors has to show the broken one
   * rather than fail.
   */
  async list(): Promise<ConnectorRow[]> {
    return await Promise.all(
      this.#connectors.map(async (connector) => {
        const entry = this.#entries.find((candidate) => candidate.id === connector.id);
        const health = await connector.health();
        const tools = health.ok ? await this.#toolsOf(connector) : [];
        return {
          id: connector.id,
          url: entry?.url ?? "",
          ref: `connector:${connector.id}`,
          tools,
          health,
        };
      }),
    );
  }

  /**
   * The probe a person runs when they add or check a connector: does the server accept this
   * credential, and what does it offer. A refusal is a successful call whose answer says so.
   */
  async test(id: string): Promise<ConnectorTest> {
    const connector = this.#connectors.find((candidate) => candidate.id === id);
    if (connector === undefined) throw new UnknownConnectorError(id);
    try {
      const ref = await connector.authenticate();
      const tools = await connector.describe();
      return { id, ok: true, detail: `${ref} accepted, ${tools.length} tools`, tools };
    } catch (error) {
      return { id, ok: false, detail: messageOf(error), tools: [] };
    }
  }

  async #toolsOf(connector: Connector): Promise<readonly ConnectorTool[]> {
    try {
      return await connector.describe();
    } catch {
      return [];
    }
  }
}
