import { describe, expect, test } from "bun:test";
import type { ConnectorRow, ConnectorState } from "@freebot/protocol";
import {
  connectionSummary,
  connectionView,
  connectionViews,
  connectorIdFrom,
  detailActions,
  failureAction,
  removedLine,
  testedLine,
} from "./connections.ts";

function row(overrides: Partial<ConnectorRow> & { id: string }): ConnectorRow {
  return {
    label: overrides.id,
    url: `http://127.0.0.1:9/${overrides.id}`,
    ref: `connector:${overrides.id}`,
    state: "connected",
    detail: "",
    tools: [],
    testedAt: 1_760_000_000_000,
    ...overrides,
  };
}

describe("the connector state's words and control", () => {
  test("each state renders its own label and its own sentence", () => {
    const labels = ["connected", "unreachable", "untested"] as const;
    const views = labels.map((state) => connectionView(row({ id: "a", state })));

    expect(views.map((view) => view.stateLabel)).toEqual(["Connected", "Unreachable", "Untested"]);
    expect(views[1]?.stateLine).toContain("did not answer");
    expect(views[2]?.stateLine).toContain("holds no credential");
  });

  test("a connected connector offers no failure control", () => {
    expect(failureAction("connected")).toBeNull();
  });

  test("an unreachable connector's failure control is Retry", () => {
    const action = failureAction("unreachable");
    expect(action?.id).toBe("retry");
    expect(action?.label).toBe("Retry");
  });

  test("an untested connector's failure control is Authorize", () => {
    const action = failureAction("untested");
    expect(action?.id).toBe("authorize");
    expect(action?.label).toBe("Authorize");
  });

  test("the detail page offers Reconnect beside Retry, and nothing on a healthy one", () => {
    expect(detailActions("connected").map((action) => action.label)).toEqual(["Test"]);
    expect(detailActions("unreachable").map((action) => action.label)).toEqual([
      "Retry",
      "Reconnect",
    ]);
    expect(detailActions("untested").map((action) => action.label)).toEqual(["Authorize", "Test"]);
  });
});

describe("the connector list model", () => {
  test("states that need a person sort above healthy ones, then by label", () => {
    const rows: ConnectorRow[] = [
      row({ id: "zulu", label: "Zulu" }),
      row({ id: "alpha", label: "Alpha" }),
      row({ id: "notes", label: "Notes", state: "untested" }),
      row({ id: "broken", label: "Broken", state: "unreachable" }),
    ];

    expect(connectionViews(rows).map((view) => view.id)).toEqual([
      "broken",
      "notes",
      "alpha",
      "zulu",
    ]);
  });

  test("a row carries its tools, its reference and its probe's own words", () => {
    const view = connectionView(
      row({
        id: "emulate-github",
        label: "Emulated GitHub",
        state: "connected",
        ref: "connector:emulate-github",
        detail: "connector:emulate-github accepted, 2 tools",
        tools: [
          { name: "create_issue", description: "Open an issue.", parameters: {} },
          { name: "list_issues", description: "List the issues.", parameters: {} },
        ],
        testedAt: Date.parse("2026-10-19T09:14:00.000Z"),
      }),
    );

    expect(view.toolCount).toBe(2);
    expect(view.tools.map((tool) => tool.name)).toEqual(["create_issue", "list_issues"]);
    expect(view.ref).toBe("connector:emulate-github");
    expect(view.detail).toBe("connector:emulate-github accepted, 2 tools");
    expect(view.testedLine).toBe("Tested 2026-10-19 09:14 UTC");
    expect(view.monogram).toBe("EM");
  });

  test("a record that was never probed says so rather than showing a zero time", () => {
    expect(testedLine(null)).toBe("Never tested");
  });

  test("the summary counts connected and attention from the records", () => {
    const rows: ConnectorRow[] = [
      row({ id: "a" }),
      row({ id: "b", state: "unreachable" }),
      row({ id: "c", state: "untested" }),
    ];

    expect(connectionSummary(rows)).toEqual({
      on: 1,
      attention: 2,
      total: 3,
      label: "1 on",
    });
  });

  test("removal says whether there was a record to remove", () => {
    expect(removedLine("Notes", true)).toBe(
      "Removed Notes. Its record and its credential are gone.",
    );
    expect(removedLine("Notes", false)).toBe("Notes was already gone.");
  });
});

describe("the id a new connector takes", () => {
  test("a name becomes one lower-case slug", () => {
    expect(connectorIdFrom("Emulated GitHub", [])).toBe("emulated-github");
    expect(connectorIdFrom("  NOTES!! ", [])).toBe("notes");
    expect(connectorIdFrom("---", [])).toBe("connector");
  });

  test("a taken id takes the next free suffix rather than rotating the first connector", () => {
    expect(connectorIdFrom("Notes", ["notes"])).toBe("notes-2");
    expect(connectorIdFrom("Notes", ["notes", "notes-2"])).toBe("notes-3");
  });

  test("a long name still fits the contract's 64-character id", () => {
    const id = connectorIdFrom("a".repeat(80), []);
    expect(id.length).toBe(40);
    expect(connectorIdFrom("a".repeat(80), [id])).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  test("every id it produces is one the contract accepts", () => {
    for (const state of ["connected", "unreachable", "untested"] as ConnectorState[]) {
      expect(connectorIdFrom(`Connector ${state}`, [])).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    }
  });
});
