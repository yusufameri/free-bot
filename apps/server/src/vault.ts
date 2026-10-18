/**
 * The vault: the run path's only reader of `~/.freebot/provider.env`, the provider page's only
 * writer of it, and the one writer of every other secret file this app keeps.
 *
 * Order 8 keeps keys in the vault path and nowhere else, so the readers here read the file itself
 * and never the process environment. A key in the environment is visible to every child process the
 * run spawns and to `ps`; a key in this record is visible only to the one `Authorization` header the
 * client builds. Nothing here logs a value, and `describeVault` and the provider choice carry
 * presence, a path and a mode instead.
 *
 * `readPrivateFile` and `writePrivateFile` are the discipline every file this app keeps under the
 * freebot home shares: mode 600 on every write, one reader and one writer per file.
 * `writeSecretFile` adds the vault's own shape, one `NAME=value` per line. A connector's credential
 * is the second consumer (see `connectors.ts`), and it goes through these rather than around them.
 *
 * An absent or unreadable vault is not an error. It is the keyless machine, and the run replays.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The vault's own defaults, matching the landed Pi smoke test's. */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

/** The home the store lives under, per `freebot doctor`'s convention. */
export function freebotHome(env: Record<string, string | undefined> = process.env): string {
  return env.FREEBOT_HOME ?? join(homedir(), ".freebot");
}

export function vaultPath(env: Record<string, string | undefined> = process.env): string {
  return join(freebotHome(env), "provider.env");
}

export interface VaultEntry {
  /** The key. It reaches one `Authorization` header and nothing else. */
  readonly key: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** What a caller may say about the vault without saying anything secret. */
export interface VaultDescription {
  readonly path: string;
  readonly present: boolean;
  /** The file's permission bits, octal, or null when there is no file to read. */
  readonly mode: string | null;
}

/** One `NAME=value` line, with a leading `export ` and one layer of quotes tolerated. */
function envValue(text: string, name: string): string | null {
  for (const line of secretLines(text)) {
    if (line.name === name && line.value.length > 0) return line.value;
  }
  return null;
}

/**
 * Every `NAME=value` line of a secret file, in the order the file holds them.
 *
 * The name's own characters are wide on purpose: `provider.env`'s names are upper case, and a
 * connector's credential line is named after the connector's id, which carries dashes. A value
 * keeps every byte after the first `=` on its line, so a JSON value survives it.
 */
export function secretLines(
  text: string,
): Array<{ readonly name: string; readonly value: string }> {
  const found: Array<{ name: string; value: string }> = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const raw = (match[2] ?? "").trim();
    const unquoted =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw;
    found.push({ name: match[1] ?? "", value: unquoted });
  }
  return found;
}

/** A file under the freebot home, read as text, or null when there is no file to read. */
export function readPrivateFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The one writer of a private file, and the discipline every writer of one under the home follows.
 *
 * The order is write-then-chmod rather than `writeFileSync`'s own `mode`, because that mode applies
 * to a create only: a second write over an existing file would keep whatever mode it already had.
 * Both calls ask for 600, so the file is unreadable to anyone but its owner on every path.
 */
export function writePrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * A private file in the vault's own shape: one `NAME=value` per line, every value on one line,
 * because a value with a break in it would rewrite the file's shape rather than be one of its lines.
 */
export function writeSecretFile(path: string, lines: readonly string[]): void {
  for (const line of lines) {
    if (/[\r\n]/.test(line)) {
      throw new Error("a secret line carries a line break, which would rewrite the file's shape");
    }
  }
  writePrivateFile(path, `${lines.join("\n")}\n`);
}

/**
 * The vault's key plus the endpoint it belongs to, or null when the machine holds no key. A file
 * this process cannot read is null too: a permissions problem must not become a crash the operator
 * cannot see, and the launcher reports the path it looked at.
 */
export function readVault(path: string = vaultPath()): VaultEntry | null {
  const text = readPrivateFile(path);
  if (text === null) return null;
  const key = envValue(text, "FREEBOT_BYOK_KEY");
  if (key === null) return null;
  return {
    key,
    baseUrl: envValue(text, "FREEBOT_BYOK_BASE_URL") ?? DEFAULT_BASE_URL,
    model: envValue(text, "FREEBOT_BYOK_MODEL") ?? DEFAULT_MODEL,
  };
}

export function describeVault(path: string = vaultPath()): VaultDescription {
  let mode: string | null = null;
  try {
    mode = (statSync(path).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    mode = null;
  }
  return { path, present: readVault(path) !== null, mode };
}

/**
 * The vault's writer: the provider page's save, and the only thing in the app that writes this file.
 *
 * The key is the first value here and it goes no further. Nothing in this module logs, returns
 * through a reader, or copies a value into the process environment.
 */
export function writeVault(entry: VaultEntry, path: string = vaultPath()): void {
  writeSecretFile(path, [
    "# freebot's BYOK vault. Written by the app's provider page and read by the run path alone.",
    `FREEBOT_BYOK_KEY=${entry.key}`,
    `FREEBOT_BYOK_BASE_URL=${entry.baseUrl}`,
    `FREEBOT_BYOK_MODEL=${entry.model}`,
  ]);
}
