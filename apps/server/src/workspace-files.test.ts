/**
 * The workspace reader's scoping rules, at the boundary that owns them.
 *
 * Every case here fails closed: a refused path raises one named refusal and returns no bytes. The
 * three escapes the brief names (an absolute path, a `..` segment, and a symlink pointing outside)
 * are one group each, asserting the literal refusal name and the message the surface will carry.
 *
 * The root is a fresh temporary directory, so the test builds its own `..` neighbours and its own
 * outside target rather than leaning on the machine's filesystem layout.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_FILE_MAX_BYTES } from "@freebot/protocol";
import { createWorkspaceReader, WorkspaceReadError } from "./workspace-files.ts";

const made: string[] = [];

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  made.push(path);
  return path;
}

interface Fixture {
  readonly root: string;
  readonly outside: string;
  readonly reader: ReturnType<typeof createWorkspaceReader>;
}

/**
 * A workspace with one text file inside, one file outside it, a symlink to each, and a symlink that
 * stays inside. Every assertion below reads what these names mean rather than the disk layout.
 */
function fixture(): Fixture {
  const root = tempDir("freebot-ws-");
  const outside = realpathSync(tempDir("freebot-outside-"));
  writeFileSync(join(outside, "secret.txt"), "outside bytes\n");
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "readme.txt"), "the container wrote this\n");
  writeFileSync(join(root, "notes", "todo.md"), "- one\n- two\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  symlinkSync(outside, join(root, "escape-dir"));
  symlinkSync("readme.txt", join(root, "inside-link.txt"));
  return { root, outside, reader: createWorkspaceReader(root) };
}

/** The refusal a call raised, or the value it returned instead. */
async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    return `returned ${JSON.stringify(await call())}`;
  } catch (error) {
    if (error instanceof WorkspaceReadError) return `${error.refusal} :: ${error.message}`;
    throw error;
  }
}

describe("a path that leaves the workspace", () => {
  test("an absolute path is refused by name, with no bytes", async () => {
    const { reader, root } = fixture();
    expect(await outcome(() => reader.read("/etc/passwd"))).toBe(
      "absolute_path :: absolute_path: /etc/passwd",
    );
    expect(await outcome(() => reader.read(`${root}/readme.txt`))).toBe(
      `absolute_path :: absolute_path: ${root}/readme.txt`,
    );
    expect(await outcome(() => reader.list("/etc"))).toBe("absolute_path :: absolute_path: /etc");
  });

  test("a .. segment is refused at the head, in the middle, and at the tail", async () => {
    const { reader } = fixture();
    expect(await outcome(() => reader.read("../outside/secret.txt"))).toBe(
      "parent_traversal :: parent_traversal: ../outside/secret.txt",
    );
    expect(await outcome(() => reader.read("notes/../../etc/passwd"))).toBe(
      "parent_traversal :: parent_traversal: notes/../../etc/passwd",
    );
    expect(await outcome(() => reader.list("notes/.."))).toBe(
      "parent_traversal :: parent_traversal: notes/..",
    );
  });

  test("a symlink that resolves outside is refused, and the message names where it pointed", async () => {
    const { reader, outside } = fixture();
    expect(await outcome(() => reader.read("escape.txt"))).toBe(
      `symlink_escape :: symlink_escape: escape.txt resolves to ${join(outside, "secret.txt")}`,
    );
    expect(await outcome(() => reader.list("escape-dir"))).toBe(
      `symlink_escape :: symlink_escape: escape-dir resolves to ${outside}`,
    );
    expect(await outcome(() => reader.read("escape-dir/secret.txt"))).toBe(
      `symlink_escape :: symlink_escape: escape-dir/secret.txt resolves to ${join(outside, "secret.txt")}`,
    );
  });

  test("a symlink that stays inside is read like the file it names", async () => {
    const { reader } = fixture();
    expect(await reader.read("inside-link.txt")).toEqual({
      path: "inside-link.txt",
      text: "the container wrote this\n",
      size: 25,
      truncated: false,
    });
  });
});

describe("the listing", () => {
  test("directories come first, and every entry carries its own path, kind and size", async () => {
    const { reader } = fixture();
    const listing = await reader.list(".");
    expect(listing.path).toBe(".");
    expect(listing.entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([
      ["notes", "dir", 0],
      ["escape-dir", "file", 0],
      ["escape.txt", "file", 0],
      ["inside-link.txt", "file", 25],
      ["readme.txt", "file", 25],
    ]);
    expect(listing.entries.every((entry) => Number.isInteger(entry.mtimeMs))).toBe(true);
    expect(await reader.list("notes")).toEqual({
      path: "notes",
      entries: [
        {
          name: "todo.md",
          path: "notes/todo.md",
          kind: "file",
          size: 12,
          mtimeMs: expect.any(Number),
        },
      ],
    });
  });

  test("a file is not a directory, and a missing path is named", async () => {
    const { reader } = fixture();
    expect(await outcome(() => reader.list("readme.txt"))).toBe(
      "not_a_directory :: not_a_directory: readme.txt",
    );
    expect(await outcome(() => reader.list("nope"))).toBe("path_not_found :: path_not_found: nope");
  });
});

describe("the read", () => {
  test("a directory, a missing path, and binary bytes are each refused by name", async () => {
    const { reader, root } = fixture();
    expect(await outcome(() => reader.read("notes"))).toBe("not_a_file :: not_a_file: notes");
    expect(await outcome(() => reader.read("nope.txt"))).toBe(
      "path_not_found :: path_not_found: nope.txt",
    );
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    expect(await outcome(() => reader.read("blob.bin"))).toBe(
      "binary_file :: binary_file: blob.bin",
    );
    writeFileSync(join(root, "bad.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    expect(await outcome(() => reader.read("bad.bin"))).toBe("binary_file :: binary_file: bad.bin");
  });

  test("a file past the cap comes back as a prefix, and its size is the bytes on disk", async () => {
    const { reader, root } = fixture();
    const big = "a".repeat(READ_FILE_MAX_BYTES + 10);
    writeFileSync(join(root, "big.txt"), big);
    const read = await reader.read("big.txt");
    expect([read.text.length, read.size, read.truncated]).toEqual([
      READ_FILE_MAX_BYTES,
      big.length,
      true,
    ]);
  });

  test("an empty file is text, not binary", async () => {
    const { reader, root } = fixture();
    writeFileSync(join(root, "empty.txt"), "");
    expect(await reader.read("empty.txt")).toEqual({
      path: "empty.txt",
      text: "",
      size: 0,
      truncated: false,
    });
  });
});
