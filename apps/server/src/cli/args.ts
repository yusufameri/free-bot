/**
 * The `bun run up` command line: one flag set, parsed once at the boundary.
 *
 * Every flag the launcher accepts is here and nowhere else, so the launcher's behavior is a
 * function of this one record. A port defaults to 0, which asks the OS for a free one: two launches
 * then cannot collide, and a port the operator pins that is already taken fails loudly instead of
 * silently moving somewhere they did not ask for.
 */

export interface UpArgs {
  /** The page and its stream. 0 asks the OS for a free port. */
  readonly apiPort: number;
  /** The tunnel leg. 0 asks the OS for a free port. */
  readonly tunnelPort: number;
  /** Open the printed URL in the operator's browser. */
  readonly open: boolean;
  /** Print the usage and exit. */
  readonly help: boolean;
}

export const UP_USAGE = [
  "usage: bun run up [flags]",
  "",
  "Boots the server and the page it serves, then prints one URL to open.",
  "The operator token is already in that URL's fragment, so the page is armed when it loads.",
  "",
  "flags:",
  "  --no-open          print the URL, do not open a browser",
  "  --api-port <n>     the page and its stream (default 0, a free port)",
  "  --tunnel-port <n>  the tunnel leg (default 0, a free port)",
  "  -h, --help         print this",
  "",
  "Ctrl-C stops the servers and removes the sandbox containers this launch created.",
].join("\n");

/** A caller's own mistake, reported with the usage rather than as a crash. */
export class UpArgError extends Error {}

function port(value: string | undefined, flag: string): number {
  if (value === undefined) throw new UpArgError(`${flag} needs a port number`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new UpArgError(`${flag} needs an integer port 0..65535, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function parseUpArgs(argv: readonly string[]): UpArgs {
  const args: UpArgs = {
    apiPort: 0,
    tunnelPort: 0,
    open: true,
    help: argv.includes("--help") || argv.includes("-h"),
  };
  let next: UpArgs = args;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    switch (flag) {
      case "--help":
      case "-h":
        break;
      case "--no-open":
        next = { ...next, open: false };
        break;
      case "--open":
        next = { ...next, open: true };
        break;
      case "--api-port":
        next = { ...next, apiPort: port(argv[index + 1], flag) };
        index += 1;
        break;
      case "--tunnel-port":
        next = { ...next, tunnelPort: port(argv[index + 1], flag) };
        index += 1;
        break;
      default:
        throw new UpArgError(`unknown flag ${JSON.stringify(flag)}`);
    }
  }
  return next;
}

/**
 * The one URL. The token rides the fragment, which a browser never sends to a server, so the page
 * can only read it locally and no access log or `Referer` ever carries it (docs/one-run-path.md).
 */
export function pageUrl(apiPort: number, token: string): string {
  return `http://127.0.0.1:${apiPort}/#token=${token}`;
}
