/**
 * The pin check's recovery branches, against a fake image inventory.
 *
 * The engine is the boundary, so this suite needs no daemon: it fixes the inventory and the tag's
 * current target, calls `ensurePinnedImage` the way the adapters do, and reads the state the call
 * leaves behind. The live counterpart is `packages/verify/scripts/sandbox-pin-repair.ts`.
 */

import { describe, expect, test } from "bun:test";
import { ensurePinnedImage, type ImageEngine, type LocalImage, PINNED_IMAGE } from "./image.ts";
import { SandboxError } from "./interface.ts";

const OFF_LAYERS = ["sha256:0ff0000000000000000000000000000000000000000000000000000000000000"];
const OFF_ID = "sha256:0ff0000000000000000000000000000000000000000000000000000000000000";
const MATCH_ID = "sha256:ab50000000000000000000000000000000000000000000000000000000000000";
const BUILT_ID = "sha256:b001000000000000000000000000000000000000000000000000000000000000";
const BUILD_REF = `${PINNED_IMAGE.tag}-build`;

class FakeEngine implements ImageEngine {
  readonly images = new Map<string, readonly string[]>();
  readonly refs = new Map<string, string>();
  readonly builds: string[] = [];
  buildLayers: readonly string[] = PINNED_IMAGE.layers;

  constructor(images: Record<string, readonly string[]>, refs: Record<string, string>) {
    for (const [id, layers] of Object.entries(images)) this.images.set(id, layers);
    for (const [ref, id] of Object.entries(refs)) this.refs.set(ref, id);
  }

  async listIds(): Promise<string[]> {
    return [...this.images.keys()];
  }

  async inspect(ids: readonly string[]): Promise<LocalImage[]> {
    return ids
      .filter((id) => this.images.has(id))
      .map((id) => ({ id, layers: this.images.get(id) as readonly string[] }));
  }

  async resolveRef(ref: string): Promise<string[]> {
    const id = this.refs.get(ref);
    return id === undefined ? [] : [id];
  }

  async tag(id: string, ref: string): Promise<void> {
    if (!this.images.has(id)) throw new Error(`no image ${id}`);
    this.refs.set(ref, id);
  }

  async removeRef(ref: string): Promise<void> {
    this.refs.delete(ref);
  }

  async build(ref: string): Promise<void> {
    this.builds.push(ref);
    this.images.set(BUILT_ID, this.buildLayers);
    this.refs.set(ref, BUILT_ID);
  }
}

async function refusal(promise: Promise<unknown>): Promise<{ error: unknown; message: string }> {
  let error: unknown = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (error === null) throw new Error("expected ensurePinnedImage to refuse");
  return { error, message: error instanceof Error ? error.message : String(error) };
}

describe("ensurePinnedImage", () => {
  test("re-points an off-pin tag at a local layer match without building", async () => {
    const engine = new FakeEngine(
      { [OFF_ID]: OFF_LAYERS, [MATCH_ID]: PINNED_IMAGE.layers },
      { [PINNED_IMAGE.tag]: OFF_ID },
    );
    const log: string[] = [];

    const pinned = await ensurePinnedImage({ engine, log: (line) => log.push(line) });

    expect(engine.refs.get(PINNED_IMAGE.tag)).toBe(MATCH_ID);
    expect(pinned.imageId).toBe(MATCH_ID);
    expect(pinned.layers).toEqual([...PINNED_IMAGE.layers]);
    expect(engine.builds).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]).toBe(
      `sandbox pin repair: ${PINNED_IMAGE.tag} pointed at ${OFF_ID.slice(7, 19)} whose layer set differs; re-pointed it at ${MATCH_ID.slice(7, 19)}, whose layer set matches docs/sandbox-image.md`,
    );
  });

  test("refuses with the repair command and leaves no off-pin tag when nothing matches", async () => {
    const engine = new FakeEngine({ [OFF_ID]: OFF_LAYERS }, { [PINNED_IMAGE.tag]: OFF_ID });

    const { error, message } = await refusal(ensurePinnedImage({ engine }));

    expect(error).toBeInstanceOf(SandboxError);
    expect(message).toContain("7 layers");
    expect(message).toContain(OFF_ID);
    expect(message).toContain("scanned 1 local images");
    expect(message).toContain("bash packages/sandbox/image/run.sh");
    expect(message).toContain(`update PINNED_IMAGE.layers and docs/sandbox-image.md in one commit`);
    expect(engine.refs.has(PINNED_IMAGE.tag)).toBe(false);
    expect(engine.refs.get(`${PINNED_IMAGE.tag}-off-pin-${OFF_ID.slice(7, 19)}`)).toBe(OFF_ID);
    expect(engine.builds).toEqual([]);
  });

  test("builds a missing image, promotes it on a pin match, and removes the scratch tag", async () => {
    const engine = new FakeEngine({}, {});

    const pinned = await ensurePinnedImage({ engine, log: () => {} });

    expect(engine.builds).toEqual([BUILD_REF]);
    expect(engine.refs.get(PINNED_IMAGE.tag)).toBe(BUILT_ID);
    expect(engine.refs.has(BUILD_REF)).toBe(false);
    expect(pinned.layers).toEqual([...PINNED_IMAGE.layers]);
  });

  test("refuses a build whose layer set differs, and keeps the canonical tag unset", async () => {
    const engine = new FakeEngine({}, {});
    engine.buildLayers = OFF_LAYERS;

    const { message } = await refusal(ensurePinnedImage({ engine }));

    expect(message).toContain("does not match the pin");
    expect(message).toContain(OFF_LAYERS[0] as string);
    expect(message).toContain("update PINNED_IMAGE.layers and docs/sandbox-image.md in one commit");
    expect(engine.refs.has(PINNED_IMAGE.tag)).toBe(false);
    expect(engine.refs.has(BUILD_REF)).toBe(false);
  });

  test("returns a matching tag without tagging or building", async () => {
    const engine = new FakeEngine(
      { [MATCH_ID]: PINNED_IMAGE.layers },
      { [PINNED_IMAGE.tag]: MATCH_ID },
    );

    const pinned = await ensurePinnedImage({ engine, log: () => {} });

    expect(pinned.imageId).toBe(MATCH_ID);
    expect(engine.refs.get(PINNED_IMAGE.tag)).toBe(MATCH_ID);
    expect(engine.builds).toEqual([]);
  });
});
