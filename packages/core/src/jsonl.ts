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
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Replace a file's contents without ever letting a reader, or a crash, see it half-written: the
 * bytes go to a neighbour, are fsynced, and the neighbour is renamed over the target, and the
 * directory is fsynced so the rename is what survives a power cut. Rewriting the live file in place
 * would leave a window that starts by truncating it, which is a window where records a previous
 * append already fsynced are gone and the crash that lands in the middle of it keeps them gone.
 */
function rewriteAtomically(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const neighbour = `${path}.${process.pid}.tmp`;
  const fd = openSync(neighbour, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(neighbour, path);
  } catch (error) {
    try {
      unlinkSync(neighbour);
    } catch {
      // The rename is what failed and the reason for it is the error being thrown; a neighbour that
      // survives one attempt at removing it is a stray file, not a second failure worth reporting.
    }
    throw error;
  }
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export class JsonlFile {
  readonly #path: string | undefined;
  #fd: number | null = null;
  /** Why this instance cannot append any more: a write whose bytes could not be taken back. */
  #broken: string | null = null;

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
    if (!text.endsWith("\n")) {
      // The repair replaces the file, so a handle this instance holds would go on appending to the
      // inode nothing reads any more. Dropping it makes the next append reopen the file by name.
      this.close();
      rewriteAtomically(this.#path, complete);
    }
    return {
      lines: complete.split("\n").filter((line) => line.trim().length > 0),
      tornTrailingLine: !text.endsWith("\n"),
    };
  }

  /**
   * Append one line and wait for the disk to have it. Creates the directory on first use.
   *
   * A write this call cannot vouch for is taken back out of the file before the error is thrown:
   * the caller keeps its seq, so a record nobody was told about must not be left where the next
   * append can put a second one beside it. If even that cannot be done the file's tail is unknown,
   * and this instance refuses every later append rather than writing a record the caller may
   * already have used.
   */
  append(line: string): void {
    const path = this.#path;
    if (path === undefined) return;
    if (this.#broken !== null) {
      throw new Error(`this journal cannot be appended to: ${this.#broken}`);
    }
    if (this.#fd === null) {
      mkdirSync(dirname(path), { recursive: true });
      this.#fd = openSync(path, "a");
    }
    const fd = this.#fd;
    const before = fstatSync(fd).size;
    try {
      writeSync(fd, `${line}\n`);
      fsyncSync(fd);
    } catch (error) {
      try {
        ftruncateSync(fd, before);
        fsyncSync(fd);
      } catch {
        this.#broken = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
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
    rewriteAtomically(path, lines.map((line) => `${line}\n`).join(""));
  }

  /** Release the handle. A process that dies here leaves exactly the records it applied. */
  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }
}
