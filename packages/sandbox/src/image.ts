/**
 * The pinned sandbox image, as recorded by U0.6 in `docs/sandbox-image.md`.
 *
 * Docker gives a locally built image no registry manifest digest, so the pin a consumer can check
 * is the pair below: the base image digest pinned in the Dockerfile, and the RootFS layer set the
 * U0.6 build produced. The layer set is byte-identical across rebuilds; the image Id is not,
 * because the config carries build timestamps. `ensurePinnedImage` asserts the layer set, so a
 * rebuilt or swapped image fails loudly instead of drifting.
 *
 * Layer sets are arch-specific and were recorded from an arm64 build (order 18: this Mac builds).
 *
 * The data shape here is an inventory of `LocalImage` records and a decision over that inventory.
 * The Docker CLI is an `ImageEngine` at the boundary, so the decision runs against a fake
 * inventory in tests and against the real daemon in production. Order 48 shapes the boundary: a
 * tag is resolved to an id through `docker images` and the id is inspected, never the tag itself,
 * because something on this machine re-points `freebot-sandbox:u0.6` fast enough that an inspect
 * of the tag can fail or return an empty layer list mid-churn.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCKER_BUILD_TIMEOUT_MS, dockerCli, dockerFailure, dockerOutcome } from "./docker-cli.ts";
import { SandboxError } from "./interface.ts";

/** Repository root, resolved from this module's location. */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const PINNED_IMAGE = {
  /** Tag produced by `bash packages/sandbox/image/run.sh`. */
  tag: "freebot-sandbox:u0.6",
  /** Node base digest pinned in the Dockerfile's `FROM ...@sha256:...`. */
  baseDigest: "sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5",
  /** Image Id the U0.6 build reported. Per-build; recorded, not asserted. */
  recordedId: "sha256:9d0dfd169778839640084e90deae1dfd2aa08a2b1edac1c1451ef2e1531719f8",
  /** The U0.6 layer set. This is the content identity every consumer asserts. */
  layers: [
    "sha256:dca69811453d69d10b6c0345a5c49147162abe20a2f77802d66efc60667949ea",
    "sha256:da0c0c58041e871b63d148c451055f55713093889b5be37ad753bda51516a864",
    "sha256:30f65559f915c9c93f6787bb6bd7690c5df44fa4525abd719396d6764adb9c66",
    "sha256:84e62bf59c8da03d305b081c73cfb6505b47b157e35f8f2a02aa010a5098319f",
    "sha256:ce3defcc04f94f253fc43a46d5e219e9eaa32e7231ab12561922b65bae914331",
    "sha256:52191768128deabdb95b5103f5981c28d15f8adcd1e9dfecf791e6a8eb1290ae",
    "sha256:6764b05ff971fe9c0b59f9f38481cf44e7879401e20b04807d3898652ab2e35c",
  ],
  /** Recipe; the rebuild source of truth. */
  dockerfile: "packages/sandbox/image/Dockerfile",
  platform: "linux/arm64",
} as const;

export interface PinnedImage {
  /** The docker reference to run. */
  readonly ref: string;
  /** The Id this host's build produced (differs per build; see the module comment). */
  readonly imageId: string;
  readonly layers: readonly string[];
}

/** One local image as the engine reports it. The id is content-addressed; the layers are the pin. */
export interface LocalImage {
  readonly id: string;
  readonly layers: readonly string[];
}

/**
 * The image operations the pin check needs. Production is `dockerImageEngine`; the unit tests pass
 * a fake inventory, which is what lets the repair branch run with no daemon.
 */
export interface ImageEngine {
  /** Every local image id, deduplicated. */
  listIds(): Promise<string[]>;
  /** Inspect ids and return the images that still exist. Missing ids are skipped, not fatal. */
  inspect(ids: readonly string[]): Promise<LocalImage[]>;
  /** The ids a tag resolves to, read through `docker images` (order 48), never `inspect <tag>`. */
  resolveRef(ref: string): Promise<string[]>;
  tag(id: string, ref: string): Promise<void>;
  /** Remove one tag. The image survives while another tag names it. */
  removeRef(ref: string): Promise<void>;
  /** Build the pinned recipe and name the result `ref`. */
  build(ref: string): Promise<void>;
}

export interface EnsurePinnedImageOptions {
  readonly engine?: ImageEngine;
  /** The repair line and the build line. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
}

const INSPECT_FORMAT = "{{.Id}}\t{{json .RootFS}}";

/** Parse the one-line-per-image output of `docker image inspect --format`. */
function parseInspected(stdout: string): LocalImage[] {
  const images: LocalImage[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const id = line.slice(0, separator);
    const rootfs = JSON.parse(line.slice(separator + 1)) as { Layers?: string[] };
    images.push({ id, layers: rootfs.Layers ?? [] });
  }
  return images;
}

/** The production engine. Docker's text stays at this boundary; callers get typed images. */
export function dockerImageEngine(): ImageEngine {
  return {
    async listIds() {
      const raw = await dockerCli(["images", "--no-trunc", "--format", "{{.ID}}"]);
      const ids = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      return [...new Set(ids)];
    },
    async inspect(ids) {
      if (ids.length === 0) return [];
      const args = ["image", "inspect", "--format", INSPECT_FORMAT, ...ids];
      const outcome = await dockerOutcome(args);
      const images = parseInspected(outcome.stdout.toString("utf8"));
      // A churned image can vanish between `images` and `inspect`; docker prints the survivors on
      // stdout and the missing id on stderr. Only an empty answer with a non-zero exit is a failure.
      if (outcome.exitCode !== 0 && images.length === 0) throw dockerFailure(args, outcome);
      return images;
    },
    async resolveRef(ref) {
      const raw = await dockerCli(["images", "--no-trunc", "--format", "{{.ID}}", ref]);
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },
    async tag(id, ref) {
      await dockerCli(["tag", id, ref]);
    },
    async removeRef(ref) {
      await dockerCli(["image", "rm", ref]);
    },
    async build(ref) {
      const context = join(REPO_ROOT, "packages", "sandbox", "image");
      await dockerCli(
        [
          "build",
          "--platform",
          PINNED_IMAGE.platform,
          "-t",
          ref,
          "-f",
          join(REPO_ROOT, PINNED_IMAGE.dockerfile),
          context,
        ],
        DOCKER_BUILD_TIMEOUT_MS,
      );
    },
  };
}

function matchesPin(image: LocalImage, expected: readonly string[]): boolean {
  return (
    image.layers.length === expected.length &&
    image.layers.every((layer, index) => layer === expected[index])
  );
}

function shortId(id: string): string {
  const bare = id.startsWith("sha256:") ? id.slice("sha256:".length) : id;
  return bare.slice(0, 12);
}

function describeLayers(layers: readonly string[]): string {
  return `${layers.length} layers ${JSON.stringify(layers)}`;
}

/**
 * Resolve the pinned image, repairing an off-pin tag from a local layer match before falling back
 * to a build. The repair is one `docker tag`: several local images can share the pinned layer set,
 * because the Id carries build timestamps and the layers do not.
 *
 * Refusal states are deliberate. A build that cannot match the pin never takes the canonical tag;
 * the caller gets the expected and found layer sets and the one commit that lands a new pin.
 */
export async function ensurePinnedImage(
  options: EnsurePinnedImageOptions = {},
): Promise<PinnedImage> {
  const engine = options.engine ?? dockerImageEngine();
  const log = options.log ?? ((line: string) => console.log(line));
  const expected = [...PINNED_IMAGE.layers];

  const imageAt = async (ref: string): Promise<LocalImage | null> => {
    const ids = await engine.resolveRef(ref);
    if (ids.length === 0) return null;
    const [image] = await engine.inspect([ids[0] as string]);
    return image ?? null;
  };

  const current = await imageAt(PINNED_IMAGE.tag);
  if (current !== null && matchesPin(current, expected)) {
    return { ref: PINNED_IMAGE.tag, imageId: current.id, layers: current.layers };
  }

  const inventory = await engine.inspect(await engine.listIds());
  const match = inventory.find((image) => matchesPin(image, expected)) ?? null;

  if (match !== null) {
    await engine.tag(match.id, PINNED_IMAGE.tag);
    log(
      current === null
        ? `sandbox pin repair: ${PINNED_IMAGE.tag} was not set; re-pointed it at ${shortId(match.id)}, whose layer set matches docs/sandbox-image.md`
        : `sandbox pin repair: ${PINNED_IMAGE.tag} pointed at ${shortId(current.id)} whose layer set differs; re-pointed it at ${shortId(match.id)}, whose layer set matches docs/sandbox-image.md`,
    );
    return { ref: PINNED_IMAGE.tag, imageId: match.id, layers: match.layers };
  }

  if (current !== null) {
    const aside = `${PINNED_IMAGE.tag}-off-pin-${shortId(current.id)}`;
    await engine.tag(current.id, aside);
    await engine.removeRef(PINNED_IMAGE.tag);
    throw new SandboxError(
      "docker_cli",
      `no local image matches the pinned layer set in docs/sandbox-image.md (${describeLayers(expected)}). ${PINNED_IMAGE.tag} pointed at ${current.id} with ${describeLayers(current.layers)}; scanned ${inventory.length} local images. The tag now points at nothing, and the old image is kept as ${aside}. Repair with: bash packages/sandbox/image/run.sh. If the new recipe is deliberate, update PINNED_IMAGE.layers and docs/sandbox-image.md in one commit instead.`,
    );
  }

  // The tag is absent. Build under a stable scratch tag so a build that cannot match the pin never
  // inherits the canonical name, and a retry reuses the previous scratch build.
  const scratch = `${PINNED_IMAGE.tag}-build`;
  let built = await imageAt(scratch);
  if (built !== null && !matchesPin(built, expected)) {
    await engine.removeRef(scratch);
    built = null;
  }
  if (built === null) {
    await engine.build(scratch);
    built = await imageAt(scratch);
  }
  if (built === null) {
    throw new SandboxError(
      "docker_cli",
      `the build of ${PINNED_IMAGE.dockerfile} left no image at ${scratch}`,
    );
  }
  if (!matchesPin(built, expected)) {
    await engine.removeRef(scratch);
    throw new SandboxError(
      "docker_cli",
      `the build from ${PINNED_IMAGE.dockerfile} produced ${built.id} with ${describeLayers(built.layers)}, which does not match the pin (${describeLayers(expected)}). Refusing to name it ${PINNED_IMAGE.tag}. If this recipe is deliberate, update PINNED_IMAGE.layers and docs/sandbox-image.md in one commit; otherwise fix the Dockerfile.`,
    );
  }
  await engine.tag(built.id, PINNED_IMAGE.tag);
  await engine.removeRef(scratch);
  return { ref: PINNED_IMAGE.tag, imageId: built.id, layers: built.layers };
}
