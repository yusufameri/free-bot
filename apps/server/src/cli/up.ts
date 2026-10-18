#!/usr/bin/env bun

/**
 * `bun run up`: the one command.
 *
 * Boots the server, prints exactly one line on stdout, the URL to open, with the operator token
 * already in its fragment. A person opens that URL and the page is armed: they type a prompt, start
 * a real run, answer the approval card, and watch it finish. Nothing is copied out of a log.
 *
 * The model is the vault's. The launcher asks for `auto` by default, which means a key in
 * `~/.freebot/provider.env` makes every run call a real model and no key replays the committed
 * transcript; `--live` refuses to start without a key and `--replay` records on purpose. The chosen
 * provider is named on stderr, without the key, so an operator and an evidence driver both know
 * which one ran.
 *
 * Ctrl-C stops both listeners and then removes the sandbox containers this launch created. The loop
 * removes its own on every path it can reach; a signal reaches none of them, so the record lives
 * here (see `reaping-sandbox.ts`).
 *
 * The diagnostics, including the token line the other evidence scripts read, go to stderr, so
 * stdout stays the one URL. See docs/RUNNING.md.
 */

import { ConnectorRegistry, connectorsPath as connectorsPathFor } from "../connectors.ts";
import { startServer } from "../index.ts";
import {
  type ChoiceDescription,
  chooseProvider,
  describeChoice,
  MissingKeyError,
  providerLine,
} from "../provider.ts";
import { createRunService } from "../run-service.ts";
import { describeVault, readVault } from "../vault.ts";
import { pageUrl, parseUpArgs, UP_USAGE, type UpArgs } from "./args.ts";
import { LaunchSandboxes } from "./reaping-sandbox.ts";

export interface Up {
  /** The one URL to open. The token is in its fragment. */
  readonly url: string;
  readonly apiPort: number;
  readonly tunnelPort: number;
  /** The directory that holds every Bot: the registry and one workspace directory per Bot. */
  readonly botsRoot: string;
  /** What the run's model is: the endpoint, the model id, and whether a key is in play. */
  readonly provider: ChoiceDescription;
  /** The connectors this launch holds, by id and address. Never a credential. */
  readonly connectors: ReadonlyArray<{ id: string; url: string }>;
  /** The file those connectors were read from, so a diagnostic names the file it actually read. */
  readonly connectorsFile: string;
  /** Stop the servers, then remove every container this launch created. 0 only when none survived. */
  stop(): Promise<number>;
}

export function startUp(args: UpArgs): Up {
  const sandboxes = new LaunchSandboxes();
  const vault = readVault();
  // The choice the launcher reports and the choice the service runs are the same fact: both come
  // from here, with the transcript this launch was asked for. A choice built twice from different
  // inputs is how a diagnostic comes to name a file the run is not replaying.
  const choice = chooseProvider({
    mode: args.providerMode,
    vault,
    ...(args.transcript === null ? {} : { transcript: args.transcript }),
  });
  const connectorsPath = args.connectors ?? connectorsPathFor();
  const connectors = ConnectorRegistry.fromFile(connectorsPath);
  const server = startServer({
    tunnelPort: args.tunnelPort,
    apiPort: args.apiPort,
    connectors,
    service: createRunService({
      sandbox: () => sandboxes.port(),
      mode: args.providerMode,
      connectors: connectors.connectors(),
      ...(args.transcript === null ? {} : { transcript: args.transcript }),
      ...(args.workspace === null ? {} : { botsRoot: args.workspace }),
    }),
  });
  const botsRoot = server.service.workspacesRoot;
  return {
    url: pageUrl(server.apiPort, server.token),
    apiPort: server.apiPort,
    tunnelPort: server.tunnelPort,
    botsRoot,
    provider: describeChoice(choice),
    connectors: connectors.describe(),
    connectorsFile: connectorsPath,
    async stop() {
      server.stop();
      server.service.close();
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
    if (error instanceof MissingKeyError) {
      console.error(`freebot up: ${error.message}`);
      console.error(
        "freebot up: put FREEBOT_BYOK_KEY in that file, or drop --live to replay the transcript",
      );
      return 2;
    }
    console.error(
      `freebot up: cannot listen on 127.0.0.1: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("freebot up: drop --api-port and --tunnel-port to take a free port instead");
    return 1;
  }

  console.error(
    `freebot up: page and run on 127.0.0.1:${up.apiPort}, tunnel on 127.0.0.1:${up.tunnelPort}`,
  );
  const vault = describeVault();
  console.error(`freebot up: model mode ${args.providerMode}, ${providerLine(up.provider)}`);
  console.error(
    `freebot up: vault ${vault.path} ${vault.present ? `present, mode ${vault.mode ?? "unknown"}` : "absent"}`,
  );
  console.error(
    `freebot up: bots under ${up.botsRoot}; each Bot's workspace is mounted at /workspace and kept across runs`,
  );
  console.error(
    up.connectors.length === 0
      ? `freebot up: connectors ${up.connectorsFile} holds none`
      : `freebot up: connectors ${up.connectorsFile} holds ${up.connectors
          .map((connector) => `${connector.id} at ${connector.url}`)
          .join(", ")}`,
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
  // stdout's one URL is this line. A gate refusal the landed server logs later lands on stdout too,
  // where that server writes it; a launch nobody probes writes nothing else.
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
