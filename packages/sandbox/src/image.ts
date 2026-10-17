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
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCKER_BUILD_TIMEOUT_MS, dockerCli, dockerOutcome } from "./docker-cli.ts";
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

async function imageIdOf(ref: string): Promise<string | null> {
  const outcome = await dockerOutcome(["image", "inspect", "--format", "{{.Id}}", ref]);
  if (outcome.exitCode !== 0) return null;
  const id = outcome.stdout.toString("utf8").trim();
  return id === "" ? null : id;
}

/** Resolve the pinned image: build it from the recipe if absent, then assert its content identity. */
export async function ensurePinnedImage(): Promise<PinnedImage> {
  let imageId = await imageIdOf(PINNED_IMAGE.tag);
  if (imageId === null) {
    const context = join(REPO_ROOT, "packages", "sandbox", "image");
    await dockerCli(
      [
        "build",
        "--platform",
        PINNED_IMAGE.platform,
        "-t",
        PINNED_IMAGE.tag,
        "-f",
        join(REPO_ROOT, PINNED_IMAGE.dockerfile),
        context,
      ],
      DOCKER_BUILD_TIMEOUT_MS,
    );
    imageId = await imageIdOf(PINNED_IMAGE.tag);
  }
  if (imageId === null) {
    throw new SandboxError(
      "docker_cli",
      `the pinned image did not exist after building ${PINNED_IMAGE.tag} from ${PINNED_IMAGE.dockerfile}`,
    );
  }
  const raw = await dockerCli([
    "image",
    "inspect",
    "--format",
    "{{json .RootFS.Layers}}",
    PINNED_IMAGE.tag,
  ]);
  const layers = JSON.parse(raw) as string[];
  const expected = [...PINNED_IMAGE.layers];
  const same =
    layers.length === expected.length && layers.every((layer, index) => layer === expected[index]);
  if (!same) {
    throw new SandboxError(
      "docker_cli",
      `image ${PINNED_IMAGE.tag} does not match the pinned layer set recorded in docs/sandbox-image.md (${PINNED_IMAGE.platform}); rebuild with bash packages/sandbox/image/run.sh or update the pin deliberately. layers=${JSON.stringify(layers)}`,
    );
  }
  return { ref: PINNED_IMAGE.tag, imageId, layers };
}
