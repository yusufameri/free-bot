#!/usr/bin/env bun
/**
 * The pixel gate's one command.
 *
 * `bun packages/pixel-gate/src/cli.ts` launches one headless Chrome, opens the real app and the
 * committed export in that same browser, sets each of the nine viewports `DESIGN-MANIFEST.json`
 * names, screenshots both sides at each one, and prints a literal pixel-diff statistic per viewport,
 * separating the shell's chrome regions from the content regions that carry real records.
 *
 * Flags:
 *   --viewport <name|WxH>  one viewport instead of the nine
 *   --repeat               capture each viewport twice and compare the two captures
 *   --json                 the per-viewport summary as JSON on stdout, and nothing else
 *   --no-write             do not write the artifact directory
 *   --artifact <path>      write the artifact somewhere other than the convention
 *   --stability <a> <b>    compare two committed runs instead of running one
 *
 * It exits non-zero when a chrome region exceeded its tolerance. It is not part of `bun run verify`
 * and not wired into CI; `docs/pixel-gate.md` says what U6.7 must do to arm it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHROME_TOLERANCE, chooseViewports, readViewports, run, stability } from "./gate.ts";
import { type RunReport, renderJson } from "./report.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

interface Args {
  readonly viewport?: string;
  readonly repeat: boolean;
  readonly json: boolean;
  readonly write: boolean;
  readonly artifact?: string;
  readonly stability?: readonly [string, string];
}

function parse(argv: readonly string[]): Args {
  let viewport: string | undefined;
  let repeat = false;
  let json = false;
  let write = true;
  let artifact: string | undefined;
  let stabilityPair: readonly [string, string] | undefined;
  let at = 0;
  /** The value after a flag, so a bare flag fails instead of silently changing what runs. */
  const take = (flag: string): string => {
    const next = argv[++at];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return next;
  };
  for (; at < argv.length; at++) {
    const arg = argv[at];
    switch (arg) {
      case "--viewport":
        viewport = take("--viewport");
        break;
      case "--repeat":
        repeat = true;
        break;
      case "--json":
        json = true;
        break;
      case "--no-write":
        write = false;
        break;
      case "--artifact":
        artifact = take("--artifact");
        break;
      case "--stability": {
        const a = take("--stability");
        const b = take("--stability");
        stabilityPair = [a, b];
        break;
      }
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { viewport, repeat, json, write, artifact, stability: stabilityPair };
}

function readReport(path: string): RunReport {
  return JSON.parse(readFileSync(path, "utf8")) as RunReport;
}

async function main(): Promise<number> {
  const args = parse(Bun.argv.slice(2));

  if (args.stability !== undefined) {
    const [left, right] = args.stability;
    const a = readReport(left);
    const b = readReport(right);
    const proof = stability({ first: a, second: b, epsilon: 0 });
    console.log(`stability: ${left} against ${right}, epsilon ${proof.epsilon} differing pixel(s)`);
    for (const line of proof.lines) console.log(line);
    console.log(
      proof.same
        ? "RESULT: STABLE, every chrome region's differing-pixel count is equal across the two runs"
        : "RESULT: UNSTABLE, at least one chrome region's differing-pixel count moved",
    );
    return proof.same ? 0 : 1;
  }

  const command = `bun packages/pixel-gate/src/cli.ts${Bun.argv.slice(2).length > 0 ? ` ${Bun.argv.slice(2).join(" ")}` : ""}`;
  const result = await run({
    root,
    command,
    only: args.viewport,
    repeat: args.repeat,
    write: args.write,
    dir: args.artifact,
    log: args.json ? (line: string) => console.error(line) : (line: string) => console.log(line),
  });
  if (args.json) console.log(renderJson(result.report));
  return result.exitCode;
}

/** The matrix, as the CLI prints it for `--help`-less discovery. */
export function matrix(): string {
  return readViewports(root)
    .map((viewport) => `${viewport.name} ${viewport.width}x${viewport.height}`)
    .join(", ");
}

export { CHROME_TOLERANCE, chooseViewports };

try {
  process.exit(await main());
} catch (error) {
  console.error(`pixel gate crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
