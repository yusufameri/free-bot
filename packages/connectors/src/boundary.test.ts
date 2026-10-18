/**
 * The seam's two structural promises, as failing tests rather than conventions.
 *
 * 1. No vendor above an adapter. Every import in this package is relative today, which is the
 *    strongest form of the rule: nothing in the package has a dependency to leak. The rule survives
 *    U8.3 as an allowlist of vendor-facing modules, and a bare specifier anywhere outside it fails
 *    here, so a Composio type cannot climb above the adapter unnoticed.
 * 2. A second adapter satisfies the interface. The proof is a stub that shares no code with the MCP
 *    adapter and is driven through the same consumer, which is what "U8.3 can add Composio without
 *    touching the seam" has to mean in a test.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  type Connector,
  type ConnectorHealth,
  type ConnectorResult,
  type ConnectorTool,
  namespacedToolName,
  offeredTools,
  type TokenRef,
  tokenRef,
} from "./index.ts";

const packageRoot = new URL("../", import.meta.url);
const sourceDir = new URL("./", import.meta.url);

/** The modules that may name a vendor. U8.3 puts `composio.ts` here. */
const VENDOR_FACING: readonly string[] = [];

/** The shipped surface. A test is not part of it: a test names `bun:test` and names the vendor. */
function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(sourceDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(new URL(name, sourceDir), "utf8") }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function importsOf(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

describe("the vendor boundary", () => {
  test("no source file outside a vendor adapter imports a package", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (VENDOR_FACING.includes(file.name)) continue;
      for (const specifier of importsOf(file.text)) {
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
          offenders.push(`${file.name} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the interface module imports nothing at all", () => {
    const interfaceModule = sourceFiles().find((file) => file.name === "connector.ts");
    expect(interfaceModule).toBeDefined();
    expect(importsOf(interfaceModule?.text ?? "")).toEqual([]);
  });

  test("the package declares no dependency, and no Composio type is in it before U8.3", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.devDependencies ?? {}).toEqual({});
    const named = sourceFiles()
      .filter((file) => file.text.includes("@composio"))
      .map((file) => file.name);
    expect(named).toEqual([]);
  });

  test("a model-facing name carries its connector's id, so two connectors cannot collide", () => {
    expect(namespacedToolName("github", "create_issue")).toBe("github__create_issue");
    expect(namespacedToolName("composio-gmail", "create_issue")).toBe(
      "composio-gmail__create_issue",
    );
  });
});

/**
 * The second adapter: a stub that answers from a table it was built with. It has no MCP client, no
 * URL and no credential, and nothing in it names the MCP adapter.
 */
class StubConnector implements Connector {
  readonly id: string;
  readonly ref: TokenRef;
  readonly #tools: readonly ConnectorTool[];
  readonly #answers: ReadonlyMap<string, ConnectorResult>;
  readonly calls: string[] = [];

  constructor(id: string, tools: readonly ConnectorTool[], answers: Record<string, string>) {
    this.id = id;
    this.ref = tokenRef(`stub:${id}`);
    this.#tools = tools;
    this.#answers = new Map(
      Object.entries(answers).map(([name, output]) => [name, { ok: true, output }]),
    );
  }

  async describe(): Promise<readonly ConnectorTool[]> {
    return this.#tools;
  }

  async authenticate() {
    return tokenRef(`stub:${this.id}`);
  }

  async call(tool: string, args: unknown): Promise<ConnectorResult> {
    this.calls.push(`${tool} ${JSON.stringify(args)}`);
    const answer = this.#answers.get(tool);
    if (answer === undefined) return { ok: false, output: `no such tool: ${tool}` };
    return answer;
  }

  async health(): Promise<ConnectorHealth> {
    return { ok: true, detail: `${this.#tools.length} tools` };
  }
}

/** What a consumer above the seam does with one: the tools the model is offered, then one call. */
async function offerAndCall(
  connector: Connector,
  tool: string,
  args: unknown,
): Promise<{ names: string[]; output: string; ok: boolean }> {
  const names = (await offeredTools(connector)).map((entry) => entry.name);
  const result = await connector.call(tool, args);
  return { names, output: result.output, ok: result.ok };
}

describe("a second adapter the seam admits", () => {
  test("the stub satisfies Connector and runs through the same consumer as an MCP adapter", async () => {
    const stub = new StubConnector(
      "stub-crm",
      [
        {
          name: "create_note",
          description: "Store a note.",
          parameters: { type: "object", properties: { body: { type: "string" } } },
        },
      ],
      { create_note: "stored" },
    );

    const outcome = await offerAndCall(stub, "create_note", { body: "hello" });

    expect(outcome.names).toEqual(["stub-crm__create_note"]);
    expect(outcome.output).toBe("stored");
    expect(outcome.ok).toBe(true);
    expect(stub.calls).toEqual(['create_note {"body":"hello"}']);
    expect(await stub.health()).toEqual({ ok: true, detail: "1 tools" });
    expect(await stub.authenticate()).toBe(tokenRef("stub:stub-crm"));
  });

  test("a call the stub cannot answer is a refusal, not a throw", async () => {
    const stub = new StubConnector("stub-crm", [], {});
    const outcome = await offerAndCall(stub, "create_note", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toBe("no such tool: create_note");
  });
});
