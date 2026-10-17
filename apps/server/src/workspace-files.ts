/**
 * The Bot's workspace on the host, read the way its container sees it.
 *
 * A run's container is destroyed when the run ends (`run-service.ts`), so a file a run produced
 * would otherwise be gone with it. The workspace is therefore a host directory the run service
 * creates once per Bot and bind-mounts at `/workspace` into every container that Bot runs. What the
 * model writes through `/workspace` inside the container is the bytes on this directory, and this
 * reader is the one thing that reads them back to the surface.
 *
 * Scoping is the whole point of the module, and it fails closed. The input path is refused if it is
 * absolute or carries a `..` segment, and the path's real location must stay inside the workspace's
 * real root. A symlink is a path like any other: one that stays inside the workspace is read, one
 * that resolves outside is refused by name. A refusal raises `WorkspaceReadError`, never partial
 * bytes, and the name is what the router puts on the wire.
 *
 * What a refusal is NOT is atomic: the real path is resolved and then opened, so a symlink swapped
 * between those two calls could still be followed. Closing that window needs an `openat`-style
 * handle check the Node API does not expose; `docs/files-surface.md` records it as a limit.
 */

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  type ListFilesOutput,
  READ_FILE_MAX_BYTES,
  type ReadFileOutput,
  type WorkspaceReadRefusal,
} from "@freebot/protocol";

/** A refusal, named. The router maps the name onto the wire's error code. */
export class WorkspaceReadError extends Error {
  readonly refusal: WorkspaceReadRefusal;

  constructor(refusal: WorkspaceReadRefusal, message: string) {
    super(message);
    this.name = "WorkspaceReadError";
    this.refusal = refusal;
  }
}

export interface WorkspaceReader {
  /** The workspace's real, absolute host path. */
  readonly root: string;
  /** One directory of the workspace, entries sorted with directories first. */
  list(path: string): Promise<ListFilesOutput>;
  /** One UTF-8 text file, refused by name when it is not one. */
  read(path: string): Promise<ReadFileOutput>;
}

/** Whether `target` is `root` or sits below it. Compares by whole segments, not by string prefix. */
function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * The two refusals that need no filesystem: an absolute path, and a `..` segment anywhere. The
 * contract refuses both before a handler runs; this is the same rule for a caller below it.
 */
function pathRefusal(path: string): WorkspaceReadRefusal | null {
  if (path.startsWith("/")) return "absolute_path";
  if (path.split("/").includes("..")) return "parent_traversal";
  return null;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The workspace reader over one directory. The directory is created if it is missing, because the
 * run service mounts it and a mount over an absent host path is a Docker error rather than an empty
 * workspace.
 */
export function createWorkspaceReader(root: string): WorkspaceReader {
  const absolute = resolve(root);
  mkdirSync(absolute, { recursive: true });
  // The same directory can be reached by more than one name on macOS (`/tmp` and `/private/tmp`), so
  // containment is compared against the real path, and the real path is what the reader reports.
  const realRoot = realpathSync(absolute);

  /** The path's real location, refused unless it is inside the workspace. */
  function resolveInside(path: string): string {
    const refusal = pathRefusal(path);
    if (refusal !== null) throw new WorkspaceReadError(refusal, `${refusal}: ${path}`);
    const real = realpathOrNull(resolve(realRoot, path));
    if (real === null) throw new WorkspaceReadError("path_not_found", `path_not_found: ${path}`);
    if (!inside(realRoot, real)) {
      throw new WorkspaceReadError("symlink_escape", `symlink_escape: ${path} resolves to ${real}`);
    }
    return real;
  }

  return {
    root: realRoot,

    async list(path) {
      const real = resolveInside(path);
      if (!statSync(real).isDirectory()) {
        throw new WorkspaceReadError("not_a_directory", `not_a_directory: ${path}`);
      }
      const base = path === "." ? "" : path;
      const entries = readdirSync(real, { withFileTypes: true })
        .map((entry) => {
          const entryPath = base === "" ? entry.name : `${base}/${entry.name}`;
          const absoluteEntry = join(real, entry.name);
          const stats = lstatSync(absoluteEntry);
          // A symlink is reported as what it points at when that target is inside the workspace, and
          // as an unreadable file when it is not. Stat'ing the outside target would leak its size and
          // kind, and the read that follows refuses the entry by name anyway.
          const target = stats.isSymbolicLink() ? realpathOrNull(absoluteEntry) : null;
          const escapes = stats.isSymbolicLink() && (target === null || !inside(realRoot, target));
          const followed = stats.isSymbolicLink() && !escapes ? statSync(absoluteEntry) : stats;
          return {
            name: entry.name,
            path: entryPath,
            kind: !escapes && followed.isDirectory() ? ("dir" as const) : ("file" as const),
            size: !escapes && followed.isFile() ? followed.size : 0,
            mtimeMs: Math.floor(stats.mtimeMs),
          };
        })
        .sort((left, right) =>
          left.kind === right.kind
            ? left.name.localeCompare(right.name)
            : left.kind === "dir"
              ? -1
              : 1,
        );
      return { path, entries };
    },

    async read(path) {
      const real = resolveInside(path);
      const stats = statSync(real);
      if (!stats.isFile()) throw new WorkspaceReadError("not_a_file", `not_a_file: ${path}`);
      const handle = openSync(real, "r");
      let head: Buffer;
      try {
        // One byte past the cap, so `truncated` is read off the file rather than guessed.
        const buffer = Buffer.allocUnsafe(READ_FILE_MAX_BYTES + 1);
        head = buffer.subarray(0, readSync(handle, buffer, 0, READ_FILE_MAX_BYTES + 1, 0));
      } finally {
        closeSync(handle);
      }
      if (head.includes(0)) throw new WorkspaceReadError("binary_file", `binary_file: ${path}`);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          head.length > READ_FILE_MAX_BYTES ? head.subarray(0, READ_FILE_MAX_BYTES) : head,
        );
      } catch {
        throw new WorkspaceReadError("binary_file", `binary_file: ${path}`);
      }
      return { path, text, size: stats.size, truncated: stats.size > READ_FILE_MAX_BYTES };
    },
  };
}

/** The workspace directory a Bot owns under the freebot home. */
export function botWorkspacePath(home: string, botId: string): string {
  return join(home, "bots", botId, "workspace");
}
