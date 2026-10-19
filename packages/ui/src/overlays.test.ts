/**
 * The overlays' model, as the page and the evidence read it: the rows the palette lists and the
 * query leaves, the marks it draws, the rows the picker offers at each length of a name, and the
 * two ways a file reads back.
 */

import { describe, expect, test } from "bun:test";
import type { Bot, Thread } from "@freebot/protocol";
import {
  fileFromRead,
  fileFromRefusal,
  markLabel,
  matchPalette,
  PALETTE_MAX_ROWS,
  paletteRows,
  pickerRows,
  refusalCode,
} from "./overlays.ts";

const TS = 1_792_221_550_000;

function bot(botId: string, name: string, role = ""): Bot {
  return {
    botId,
    name,
    role,
    purpose: "",
    createdAt: TS,
    threadCount: 1,
    pinned: false,
    section: "Work",
    hidden: false,
    group: false,
    members: [],
  };
}

function thread(threadId: string, title: string): Thread {
  return { threadId, botId: "bot-local", title, createdAt: TS, runs: [] };
}

const BOTS = [bot("bot-1", "Atlas", "Chief of staff"), bot("bot-2", "Recon")];
const THREADS = [thread("thr-1", "Release notes"), thread("thr-2", "Dependency sweep")];

describe("the palette's rows", () => {
  test("an empty query lists the Bots, then the selected Bot's threads, then the pages, then the actions", () => {
    const rows = paletteRows({ mode: "all", bots: BOTS, threads: THREADS });
    expect(rows.map((row) => [row.group, row.label, row.kind])).toEqual([
      ["Bots", "Atlas", "bot"],
      ["Bots", "Recon", "bot"],
      ["Threads", "Release notes", "thread"],
      ["Threads", "Dependency sweep", "thread"],
      ["Pages", "Conversation", "page"],
      ["Pages", "Library", "page"],
      ["Pages", "Connect a provider", "page"],
      ["Actions", "New Bot", "action"],
      ["Actions", "New thread", "action"],
    ]);
  });

  test("the Bots mode is the Bots group alone, which is the export's own `Cmd/Ctrl+Shift+F`", () => {
    const rows = paletteRows({ mode: "bots", bots: BOTS, threads: THREADS });
    expect(rows.map((row) => row.label)).toEqual(["Atlas", "Recon"]);
  });

  test("a row carries the command that choosing it runs, so the host needs no second table", () => {
    const rows = paletteRows({ mode: "all", bots: BOTS, threads: THREADS });
    expect(rows[0]?.command).toEqual({ run: "select-bot", botId: "bot-1" });
    expect(rows[2]?.command).toEqual({ run: "select-thread", threadId: "thr-1" });
  });

  test("a query matches a label or a group by substring, case-insensitively", () => {
    const rows = paletteRows({ mode: "all", bots: BOTS, threads: THREADS });
    expect(matchPalette(rows, "reco").map((row) => row.label)).toEqual(["Recon"]);
    expect(matchPalette(rows, "PAGES").map((row) => row.label)).toEqual([
      "Conversation",
      "Library",
      "Connect a provider",
    ]);
    expect(matchPalette(rows, "  atlas  ").map((row) => row.label)).toEqual(["Atlas"]);
  });

  test("a quoted term answers nothing, because the search it asks for has no route here", () => {
    const rows = paletteRows({ mode: "all", bots: BOTS, threads: THREADS });
    expect(matchPalette(rows, '"release notes"')).toEqual([]);
  });

  test("the list is capped at the export's forty rows", () => {
    const many = Array.from({ length: 60 }, (_, index) => bot(`bot-${index}`, `Bot ${index}`));
    const rows = paletteRows({ mode: "all", bots: many, threads: [] });
    expect(matchPalette(rows, "").length).toBe(PALETTE_MAX_ROWS);
  });

  test("a matched term is split out of the label, and a label that lacks it splits whole", () => {
    expect(markLabel("Release notes", "notes")).toEqual({
      before: "Release ",
      hit: "notes",
      after: "",
    });
    expect(markLabel("Release notes", "RELEASE")).toEqual({
      before: "",
      hit: "Release",
      after: " notes",
    });
    expect(markLabel("Release notes", "pages")).toEqual({
      before: "Release notes",
      hit: "",
      after: "",
    });
    expect(markLabel("Release notes", "")).toEqual({
      before: "Release notes",
      hit: "",
      after: "",
    });
  });
});

describe("the picker's rows", () => {
  test("an empty field offers the create row and every Bot, and no hint", () => {
    const model = pickerRows({ bots: BOTS, query: "" });
    expect(model.rows).toEqual([
      { kind: "create", label: "Create new Bot", name: "" },
      { kind: "bot", label: "Atlas", sub: "Chief of staff", botId: "bot-1" },
      { kind: "bot", label: "Recon", sub: "Bot", botId: "bot-2" },
    ]);
    expect(model.hint).toBeNull();
  });

  test("a typed name turns the first row into the Bot it would make", () => {
    const model = pickerRows({ bots: BOTS, query: "Quill" });
    expect(model.rows[0]).toEqual({
      kind: "create",
      label: "Create “Quill” Bot",
      name: "Quill",
    });
  });

  test("below three characters the field does not filter and says how many more it needs", () => {
    const model = pickerRows({ bots: BOTS, query: "At" });
    expect(model.rows.map((row) => row.label)).toEqual(["Create “At” Bot", "Atlas", "Recon"]);
    expect(model.hint).toBe("Type 1 more character to search Bots.");
    expect(pickerRows({ bots: BOTS, query: "A" }).hint).toBe(
      "Type 2 more characters to search Bots.",
    );
  });

  test("three characters filter the Bot rows and the hint goes", () => {
    const model = pickerRows({ bots: BOTS, query: "atl" });
    expect(model.rows.map((row) => row.label)).toEqual(["Create “atl” Bot", "Atlas"]);
    expect(model.hint).toBeNull();
  });

  test("a name that matches no Bot leaves the create row, which is how a new one is made", () => {
    const model = pickerRows({ bots: BOTS, query: "Nothing" });
    expect(model.rows.map((row) => row.label)).toEqual(["Create “Nothing” Bot"]);
  });
});

describe("the modal's file", () => {
  test("a file reads as its name, its path, its size and its bytes", () => {
    expect(fileFromRead({ path: "notes.md", text: "# Notes\n", size: 2048 })).toEqual({
      title: "notes.md",
      path: "notes.md",
      size: "2.0 KB",
      text: "# Notes\n",
      refusal: null,
    });
  });

  test("a nested path is titled by its last segment", () => {
    expect(fileFromRead({ path: "src/main.ts", text: "", size: 12 }).title).toBe("main.ts");
  });

  test("a refusal carries the name the server put on the wire and no bytes", () => {
    expect(fileFromRefusal("escape.txt", "symlink_escape")).toEqual({
      title: "escape.txt",
      path: "escape.txt",
      size: "",
      text: null,
      refusal: "Could not open escape.txt: symlink_escape",
    });
  });

  test("a failure that names nothing is `unknown`, rather than an empty reason", () => {
    expect(refusalCode(new Error("no code here"))).toBe("unknown");
    expect(refusalCode({ code: "path_not_found" })).toBe("path_not_found");
  });
});
