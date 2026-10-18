/**
 * The connector store, over two real files and a real MCP server.
 *
 * Every assertion reads the thing the app reads: the record file, the vault file, or what the
 * person's own server was asked. The service is `packages/connectors`' own streamable-HTTP server
 * with a bearer gate in front of its one tool, so a probe here is the wire, not a stand-in for it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorRef, createMcpServer, type McpServer } from "@freebot/connectors";
import {
  ConnectorFileError,
  type ConnectorPaths,
  ConnectorRegistry,
  connectorPaths,
  pathsBeside,
  readConnectorCredentials,
  readConnectorRecords,
  UnknownConnectorError,
} from "./connectors.ts";

const dirs: string[] = [];
const servers: McpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPaths(): ConnectorPaths {
  const dir = mkdtempSync(join(tmpdir(), "freebot-connectors-test-"));
  dirs.push(dir);
  return pathsBeside(join(dir, "connectors.json"));
}

/** The person's own service: one tool, and a gate that accepts the credential it was built with. */
function service(options: { readonly credential: string; readonly received?: string[] }): {
  url: string;
} {
  const server = createMcpServer({
    name: "connector-fixture",
    version: "1.0.0",
    tools: [
      {
        name: "create_note",
        description: "Store a note.",
        parameters: { type: "object", properties: { body: { type: "string" } } },
        run: async (args) => ({ text: `stored ${JSON.stringify(args)}` }),
      },
    ],
    authorize: (request) => {
      const header = request.headers.get("authorization");
      options.received?.push(header ?? "(none)");
      return header === options.credential ? null : "no credential";
    },
  });
  servers.push(server);
  return { url: `${server.url}/mcp` };
}

const CREDENTIAL_A = "Bearer fixture-a";
const CREDENTIAL_B = "Bearer fixture-b";

describe("the two stores, one secret", () => {
  test("a connect writes the credential to the vault and the rest to the record, both mode 600", async () => {
    const paths = tempPaths();
    const { url } = service({ credential: CREDENTIAL_A });
    const registry = ConnectorRegistry.open(paths);

    const row = await registry.connect({
      id: "fixture-service",
      label: "Fixture Service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });

    expect(statSync(paths.vault).mode & 0o777).toBe(0o600);
    expect(statSync(paths.record).mode & 0o777).toBe(0o600);
    expect(readConnectorCredentials(paths).get("fixture-service")).toEqual({
      authorization: CREDENTIAL_A,
    });

    const records = readConnectorRecords(paths);
    expect(records.map((record) => [record.id, record.label, record.url, record.ref])).toEqual([
      ["fixture-service", "Fixture Service", url, "connector:fixture-service"],
    ]);
    expect(row.state).toBe("connected");
    expect(row.tools.map((tool) => tool.name)).toEqual(["create_note"]);
    expect(records[0]?.state).toBe("connected");
    expect(typeof records[0]?.testedAt).toBe("number");
  });

  test("the record file holds no credential, and names the vault instead", async () => {
    const paths = tempPaths();
    const { url } = service({ credential: CREDENTIAL_A });
    await ConnectorRegistry.open(paths).connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });

    const text = readFileSync(paths.record, "utf8");
    expect(text.includes(CREDENTIAL_A)).toBe(false);
    expect(text.includes("Bearer")).toBe(false);
    expect(text.includes("authorization")).toBe(false);
    // The label defaults to the id when a connect does not name one.
    expect(readConnectorRecords(paths)[0]?.label).toBe("fixture-service");
  });

  test("a record that still carries a header map is refused by name, pointing at the vault", () => {
    const paths = tempPaths();
    writeFileSync(
      paths.record,
      `${JSON.stringify({
        connectors: [
          { id: "fixture-service", url: "http://127.0.0.1:1/mcp", headers: { authorization: "x" } },
        ],
      })}\n`,
    );

    expect(() => readConnectorRecords(paths)).toThrow(ConnectorFileError);
    expect(() => readConnectorRecords(paths)).toThrow(
      new RegExp(`a credential does not belong in this file, it lives in ${paths.vault}`),
    );
  });

  test("the vault beside a --connectors path is that path's own directory", () => {
    expect(pathsBeside("/tmp/u8/connectors.json")).toEqual({
      record: "/tmp/u8/connectors.json",
      vault: "/tmp/u8/connectors.env",
    });
    expect(connectorPaths({ FREEBOT_HOME: "/tmp/freebot-home" })).toEqual({
      record: "/tmp/freebot-home/connectors.json",
      vault: "/tmp/freebot-home/connectors.env",
    });
  });
});

describe("the probe is a real call through the seam", () => {
  test("connect and test both ask the person's own service, and it answers", async () => {
    const paths = tempPaths();
    const received: string[] = [];
    const { url } = service({ credential: CREDENTIAL_A, received });
    const registry = ConnectorRegistry.open(paths);

    const connected = await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });
    const tested = await registry.test("fixture-service");

    expect(connected.detail).toBe("connector:fixture-service accepted, 1 tools");
    expect(tested.state).toBe("connected");
    // Every request the service saw carried the credential, and it saw more than one: the probe is
    // the wire. The exact count is the transport's business, not this test's.
    expect([...new Set(received)]).toEqual([CREDENTIAL_A]);
    expect(received.length).toBeGreaterThan(1);
  });

  test("a credential the service refuses is a state, not a throw", async () => {
    const paths = tempPaths();
    const { url } = service({ credential: CREDENTIAL_A });
    const registry = ConnectorRegistry.open(paths);

    const row = await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_B },
    });

    expect(row.state).toBe("unreachable");
    expect(row.detail).toContain("401");
    expect(row.detail.includes(CREDENTIAL_B)).toBe(false);
    expect(readConnectorRecords(paths)[0]?.state).toBe("unreachable");
  });

  test("a record the vault holds no credential for is untested, and is never asked for one", async () => {
    const paths = tempPaths();
    const received: string[] = [];
    const { url } = service({ credential: CREDENTIAL_A, received });
    const registry = ConnectorRegistry.open(paths);
    await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });
    received.length = 0;

    expect(registry.remove("fixture-service")).toEqual({
      id: "fixture-service",
      removed: true,
    });
    // A record with no credential: the person kept the address and the vault line is gone.
    writeFileSync(
      paths.record,
      `${JSON.stringify({ connectors: [{ id: "fixture-service", url }] })}\n`,
    );

    const listed = await registry.list();
    expect(listed.map((row) => [row.state, row.tools.length])).toEqual([["untested", 0]]);
    expect(listed[0]?.detail).toContain(paths.vault);
    expect(received).toEqual([]);
  });
});

describe("rotation needs no rebuild", () => {
  test("a credential replaced in place is what the next call carries, on the same registry", async () => {
    const paths = tempPaths();
    const received: string[] = [];
    const { url } = service({ credential: CREDENTIAL_B, received });
    const registry = ConnectorRegistry.open(paths);

    await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });
    const before = received.length;
    const first = await registry.test("fixture-service");
    const seenBefore = [...new Set(received.slice(before))];

    // The same registry object, no second ConnectorRegistry and no restart: the vault line is what
    // changes, and `headers()` reads it at call time.
    await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_B },
    });
    const after = received.length;
    const second = await registry.test("fixture-service");
    const seenAfter = [...new Set(received.slice(after))];

    expect(first.state).toBe("unreachable");
    expect(seenBefore).toEqual([CREDENTIAL_A]);
    expect(second.state).toBe("connected");
    expect(seenAfter).toEqual([CREDENTIAL_B]);
  });

  test("rotating a credential does not rename the connector or lose its label", async () => {
    const paths = tempPaths();
    const { url } = service({ credential: CREDENTIAL_B });
    const registry = ConnectorRegistry.open(paths);
    await registry.connect({
      id: "fixture-service",
      label: "Fixture Service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });

    const rotated = await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_B },
    });

    expect(rotated.label).toBe("Fixture Service");
    expect(readConnectorRecords(paths).length).toBe(1);
  });
});

describe("removal really removes", () => {
  test("the credential leaves the vault, the record leaves the store, and a call is refused by name", async () => {
    const paths = tempPaths();
    const { url } = service({ credential: CREDENTIAL_A });
    const registry = ConnectorRegistry.open(paths);
    await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });

    expect(registry.remove("fixture-service")).toEqual({ id: "fixture-service", removed: true });
    expect(readConnectorCredentials(paths).has("fixture-service")).toBe(false);
    expect(readConnectorRecords(paths)).toEqual([]);
    expect(registry.connectors()).toEqual([]);
    expect(await registry.list()).toEqual([]);

    // Fail closed: the id is refused by name rather than answered with a stale credential.
    expect(registry.test("fixture-service")).rejects.toThrow(UnknownConnectorError);
    expect(registry.test("fixture-service")).rejects.toThrow("no such connector: fixture-service");

    // A second removal is not an error, and changes nothing.
    expect(registry.remove("fixture-service")).toEqual({ id: "fixture-service", removed: false });
  });

  test("removing one connector leaves another's credential exactly where it was", async () => {
    const paths = tempPaths();
    const first = service({ credential: CREDENTIAL_A });
    const second = service({ credential: CREDENTIAL_B });
    const registry = ConnectorRegistry.open(paths);
    await registry.connect({
      id: "first",
      url: first.url,
      headers: { authorization: CREDENTIAL_A },
    });
    await registry.connect({
      id: "second",
      url: second.url,
      headers: { authorization: CREDENTIAL_B },
    });

    registry.remove("first");

    expect([...readConnectorCredentials(paths).keys()]).toEqual(["second"]);
    expect(readConnectorCredentials(paths).get("second")).toEqual({
      authorization: CREDENTIAL_B,
    });
  });
});

describe("the run path's connectors", () => {
  test("a record with a credential is a connector, and one without it is not offered", async () => {
    const paths = tempPaths();
    const { url } = service({ credential: CREDENTIAL_A });
    const registry = ConnectorRegistry.open(paths);
    await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });
    const records = readConnectorRecords(paths);
    writeFileSync(
      paths.record,
      `${JSON.stringify({
        connectors: [...records, { id: "no-credential", url: "http://127.0.0.1:1/mcp" }],
      })}\n`,
    );

    expect(registry.connectors().map((connector) => connector.id)).toEqual(["fixture-service"]);
    expect(registry.describe()).toEqual([
      { id: "fixture-service", label: "fixture-service", url },
      { id: "no-credential", label: "no-credential", url: "http://127.0.0.1:1/mcp" },
    ]);
  });

  test("a connector the run path holds carries the credential's reference and no value", async () => {
    const paths = tempPaths();
    const { url } = service({ credential: CREDENTIAL_A });
    const registry = ConnectorRegistry.open(paths);
    await registry.connect({
      id: "fixture-service",
      url,
      headers: { authorization: CREDENTIAL_A },
    });

    const connector = registry.connectors()[0];
    expect(connector?.ref).toBe(connectorRef("fixture-service"));
    expect(JSON.stringify(connector?.ref)).not.toContain(CREDENTIAL_A);
  });
});
