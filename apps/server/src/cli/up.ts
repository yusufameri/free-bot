#!/usr/bin/env bun
/**
 * `bun run up`: the one command.
 *
 * Boots the server, prints exactly one line on stdout, the URL to open, with the operator token
 * already in its fragment. A person opens that URL and the page is armed: they type a prompt, start
 * a real run, answer the approval card, and watch it finish. Nothing is copied out of a log.
 *
 * Ctrl-C stops both listeners and then removes the sandbox containers this launch created. The loop
 * removes its own on every path it can reach; a signal reaches none of them, so the record lives
 * here (see `reaping-sandbox.ts`).
 *
 * The diagnostics, including the token line the other evidence scripts read, go to stderr, so
 * stdout stays the one URL. See docs/RUNNING.md.
 */

import { startServer } from "../index.ts";
import { createRunService } from "../run-service.ts";
import { pageUrl, parseUpArgs, UP_USAGE, type UpArgs } from "./args.ts";
import { LaunchSandboxes } from "./reaping-sandbox.ts";

export interface Up {
  /** The one URL to open. The token is in its fragment. */
  readonly url: string;
  readonly apiPort: number;
  readonly tunnelPort: number;
  /** Stop the servers, then remove every container this launch created. 0 only when none survived. */
  stop(): Promise<number>;
}

export function startUp(args: UpArgs): Up {
  const sandboxes = new LaunchSandboxes();
  const server = startServer({
    tunnelPort: args.tunnelPort,
    apiPort: args.apiPort,
    service: createRunService({ sandbox: () => sandboxes.port() }),
  });
  return {
    url: pageUrl(server.apiPort, server.token),
    apiPort: server.apiPort,
    tunnelPort: server.tunnelPort,
    async stop() {
      server.stop();
      const { removed, surviving } = await sandboxes.reap();
      for (const name of removed) console.error(`freebot up: removed sandbox container ${name}`);
      for (const name of surviving) {
        console.error(`freebot up: FAILED to remove sandbox container ${name}`);
      }
      return surviving.length === 0 ? 0 : 1;
    },
  };
}

function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([command, url], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    console.error("freebot up: no browser to open; open the URL above by hand");
  }
}

/** Returns the exit code for a path that ends, or null while the process is serving until a signal. */
export async function main(argv: readonly string[]): Promise<number | null> {
  let args: UpArgs;
  try {
    args = parseUpArgs(argv);
  } catch (error) {
    console.error(`freebot up: ${error instanceof Error ? error.message : String(error)}`);
    console.error(UP_USAGE);
    return 2;
  }
  if (args.help) {
    console.log(UP_USAGE);
    return 0;
  }

  let up: Up;
  try {
    up = startUp(args);
  } catch (error) {
    console.error(
      `freebot up: cannot listen on 127.0.0.1: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("freebot up: drop --api-port and --tunnel-port to take a free port instead");
    return 1;
  }

  console.error(
    `freebot up: page and run on 127.0.0.1:${up.apiPort}, tunnel on 127.0.0.1:${up.tunnelPort}`,
  );
  console.error(
    "freebot up: the operator token rides the URL's fragment and is printed nowhere else",
  );
  if (args.open) {
    openInBrowser(up.url);
    console.error("freebot up: opened the URL in your browser");
  }
  console.error(
    "freebot up: Ctrl-C stops the servers and removes this launch's sandbox containers",
  );
  // stdout carries one line and one line only: the URL to open.
  console.log(up.url);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    console.error("freebot up: stopping");
    void up.stop().then((code) => {
      console.error("freebot up: stopped");
      process.exit(code);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return null;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
