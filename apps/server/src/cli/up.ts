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
 * The sandbox backend is the machine's, chosen once here (`sandbox-backend.ts`): `--sandbox` or
 * `FREEBOT_SANDBOX` names it, and otherwise the launcher takes the Docker daemon when it answers,
 * microsandbox when `msb doctor` does, and stops with a message naming both install paths when
 * neither is there. The chosen backend is printed on stderr at boot, so the line an evidence driver
 * asserts is the launcher's own account of what it built.
 *
 * Ctrl-C stops both listeners and then removes the sandboxes this launch created, through whichever
 * backend's adapter the launch chose. The loop removes its own on every path it can reach; a signal
 * reaches none of them, so the record lives here (see `reaping-sandbox.ts`).
 *
 * The diagnostics, including the token line the other evidence scripts read, go to stderr, so
 * stdout stays the one URL. See docs/RUNNING.md.
 */

import {
  type ConnectorPaths,
  ConnectorRegistry,
  connectorPaths,
  pathsBeside,
} from "../connectors.ts";
import { startServer } from "../index.ts";
import {
  type ChoiceDescription,
  chooseProvider,
  describeChoice,
  MissingKeyError,
  providerLine,
} from "../provider.ts";
import { RUN_UNIT } from "../run-ports.ts";
import { createRunService } from "../run-service.ts";
import { describeVault, readVault } from "../vault.ts";
import { pageUrl, parseUpArgs, UP_USAGE, type UpArgs } from "./args.ts";
import { LaunchSandboxes } from "./reaping-sandbox.ts";
import {
  resolveSandboxBackend,
  type SandboxBackendChoice,
  SandboxBackendError,
} from "./sandbox-backend.ts";

export interface Up {
  /** The one URL to open. The token is in its fragment. */
  readonly url: string;
  readonly apiPort: number;
  readonly tunnelPort: number;
  /** The directory that holds every Bot: the registry and one workspace directory per Bot. */
  readonly botsRoot: string;
  /** What the run's model is: the endpoint, the model id, and whether a key is in play. */
  readonly provider: ChoiceDescription;
  /** Which sandbox backend the runs are on, and why this one. */
  readonly sandbox: SandboxBackendChoice;
  /** The connectors this launch holds, by id, label and address. Never a credential. */
  readonly connectors: ReadonlyArray<{ id: string; label: string; url: string }>;
  /** The two files those connectors were read from, so a diagnostic names what it actually read. */
  readonly connectorPaths: ConnectorPaths;
  /** Stop the servers, then remove every sandbox this launch created. 0 only when none survived. */
  stop(): Promise<number>;
}

export async function startUp(args: UpArgs): Promise<Up> {
  const sandbox = await resolveSandboxBackend(args.sandbox, args.sandboxSource, RUN_UNIT);
  const sandboxes = new LaunchSandboxes(sandbox.backend);
  const vault = readVault();
  // The choice the launcher reports and the choice the service runs are the same fact: both come
  // from here, with the transcript this launch was asked for. A choice built twice from different
  // inputs is how a diagnostic comes to name a file the run is not replaying.
  const choice = chooseProvider({
    mode: args.providerMode,
    vault,
    ...(args.transcript === null ? {} : { transcript: args.transcript }),
  });
  const paths = args.connectors === null ? connectorPaths() : pathsBeside(args.connectors);
  const connectors = ConnectorRegistry.open(paths);
  const server = startServer({
    tunnelPort: args.tunnelPort,
    apiPort: args.apiPort,
    connectors,
    service: createRunService({
      sandbox: () => sandboxes.port(),
      mode: args.providerMode,
      // A supplier rather than a list, so a connector connected while this launch is up is offered
      // to the next run. The credential itself is read from the vault at call time either way.
      connectors: () => connectors.connectors(),
      ...(args.transcript === null ? {} : { transcript: args.transcript }),
      ...(args.workspace === null ? {} : { botsRoot: args.workspace }),
    }),
  });
  const botsRoot = server.service.workspacesRoot;
  const backendId = sandbox.backend.id;
  return {
    url: pageUrl(server.apiPort, server.token),
    apiPort: server.apiPort,
    tunnelPort: server.tunnelPort,
    botsRoot,
    provider: describeChoice(choice),
    sandbox,
    connectors: connectors.describe(),
    connectorPaths: paths,
    async stop() {
      server.stop();
      server.service.close();
      const { removed, surviving } = await sandboxes.reap();
      for (const name of removed) {
        console.error(`freebot up: removed sandbox ${name} (${backendId})`);
      }
      for (const name of surviving) {
        console.error(`freebot up: FAILED to remove sandbox ${name} (${backendId})`);
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
    up = await startUp(args);
  } catch (error) {
    if (error instanceof SandboxBackendError) {
      console.error(`freebot up: ${error.message}`);
      console.error(
        "freebot up: once one is installed, --sandbox docker|microsandbox or FREEBOT_SANDBOX picks it",
      );
      return 2;
    }
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
  console.error(`freebot up: sandbox backend ${up.sandbox.backend.id} (${up.sandbox.why})`);
  const vault = describeVault();
  console.error(`freebot up: model mode ${args.providerMode}, ${providerLine(up.provider)}`);
  console.error(
    `freebot up: vault ${vault.path} ${vault.present ? `present, mode ${vault.mode ?? "unknown"}` : "absent"}`,
  );
  console.error(
    `freebot up: bots under ${up.botsRoot}; each Bot's workspace is mounted at /workspace and kept across runs`,
  );
  const roster = up.connectors
    .map((connector) => `${connector.label} (${connector.id}) at ${connector.url}`)
    .join(", ");
  console.error(
    `freebot up: connectors ${
      up.connectors.length === 0 ? "none" : roster
    }; records ${up.connectorPaths.record}, credential vault ${up.connectorPaths.vault} at mode 600`,
  );
  console.error(
    "freebot up: the operator token rides the URL's fragment and is printed nowhere else",
  );
  if (args.open) {
    openInBrowser(up.url);
    console.error("freebot up: opened the URL in your browser");
  }
  console.error(
    `freebot up: Ctrl-C stops the servers and removes this launch's sandboxes (${up.sandbox.backend.id})`,
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
