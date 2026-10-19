/**
 * One append-only JSONL file: the bytes in, the bytes out, and the one repair both journals need.
 *
 * A file whose last line has no newline ends in a write the process never reported applied, so the
 * tail is dropped and the file is repaired in place. Left there, it would turn into a malformed line
 * in the middle of the journal as soon as the next record is appended, and poison every later
 * restart. The run journal and the thread transcript both write one record per line with an fsync,
 * so both need exactly this rule, and it lives here once.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

export class JsonlFile {
  readonly #path: string | undefined;
  #fd: number | null = null;

  /** A file path, or undefined for a journal that persists nothing. */
  constructor(path: string | undefined) {
    this.#path = path;
  }

  get path(): string | undefined {
    return this.#path;
  }

  /**
   * Every complete line, in file order, with blank lines dropped. A torn trailing line is dropped
   * and the file repaired, so the next append cannot land after half a record.
   */
  read(): { lines: string[]; tornTrailingLine: boolean } {
    if (this.#path === undefined) return { lines: [], tornTrailingLine: false };
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      if (isEnoent(error)) return { lines: [], tornTrailingLine: false };
      throw error;
    }
    if (text.length === 0) return { lines: [], tornTrailingLine: false };
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    if (!text.endsWith("\n")) writeFileSync(this.#path, complete);
    return {
      lines: complete.split("\n").filter((line) => line.trim().length > 0),
      tornTrailingLine: !text.endsWith("\n"),
    };
  }

  /** Append one line and wait for the disk to have it. Creates the directory on first use. */
  append(line: string): void {
    const path = this.#path;
    if (path === undefined) return;
    if (this.#fd === null) {
      mkdirSync(dirname(path), { recursive: true });
      this.#fd = openSync(path, "a");
    }
    writeSync(this.#fd, `${line}\n`);
    fsyncSync(this.#fd);
  }

  /**
   * Replace the file with these lines. The repair path for a caller that replayed a prefix and found
   * a record it refused: the file then holds exactly the records that survived, so the next append
   * continues from the tail the journal actually kept.
   */
  replace(lines: readonly string[]): void {
    const path = this.#path;
    if (path === undefined) return;
    this.close();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  }

  /** Release the handle. A process that dies here leaves exactly the records it applied. */
  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }
}
