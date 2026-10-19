/**
 * The pixel diff, computed inside the browser that took both shots.
 *
 * Order 36e: the diff engine has no native images dependency. Both PNGs are drawn into canvases on a
 * third page of the same browser instance and compared through `getImageData`, so nothing outside
 * the browser ever decodes an image and the tool's dependency list stays inside the lockfile the
 * repo already has.
 *
 * The two functions that do the arithmetic are written once, here, as ordinary TypeScript. They are
 * injected into that page with `Function.prototype.toString`, so the code a unit test drives in Bun
 * is literally the code the browser runs. That is why they are plain functions with no imports, no
 * closure over module state and no helper calls: everything they need arrives as an argument.
 */

export interface RegionDiff {
  readonly differing: number;
  readonly total: number;
  readonly share: number;
  readonly meanAbsolute: number;
  readonly maxChannel: number;
  /** Pixels whose worst channel differs by more than 8, the share a human can actually see. */
  readonly visible: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The differing-pixel statistic for one rectangle: `a` and `b` are RGBA buffers of the same image,
 * `width` is that image's width, and the rectangle names the part to compare.
 *
 * A pixel counts as differing when any of its four channels differs at all, which is the strictest
 * reading and the one a near-zero chrome tolerance needs. `visible` is the same count over a
 * threshold, so a report can separate a real change from antialiasing noise without hiding either.
 */
export function diffRegion(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number,
): RegionDiff {
  let differing = 0;
  let visible = 0;
  let sum = 0;
  let maxChannel = 0;
  const total = w * h;
  for (let row = 0; row < h; row++) {
    let at = ((y + row) * width + x) * 4;
    for (let col = 0; col < w; col++) {
      const dr = Math.abs((a[at] ?? 0) - (b[at] ?? 0));
      const dg = Math.abs((a[at + 1] ?? 0) - (b[at + 1] ?? 0));
      const db = Math.abs((a[at + 2] ?? 0) - (b[at + 2] ?? 0));
      const da = Math.abs((a[at + 3] ?? 0) - (b[at + 3] ?? 0));
      const worst = Math.max(dr, dg, db, da);
      if (worst !== 0) differing += 1;
      if (worst > 8) visible += 1;
      if (worst > maxChannel) maxChannel = worst;
      sum += dr + dg + db + da;
      at += 4;
    }
  }
  return {
    differing,
    total,
    share: total === 0 ? 0 : differing / total,
    meanAbsolute: total === 0 ? 0 : sum / (total * 4),
    maxChannel,
    visible,
  };
}

/**
 * A hex digest of one image's bytes, so two runs can be shown to have captured the same pixels
 * rather than merely similar ones. FNV-1a over the RGBA buffer, widened by a second independent
 * multiply so a 32-bit collision cannot pass as equality.
 */
export function digestImage(data: Uint8ClampedArray): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    h1 = Math.imul(h1 ^ byte, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + byte, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * The third page's runtime. It holds the two shots as base64, decodes them through `Image` and
 * canvas, and answers a comparison or a crop. Injected once per run.
 *
 * `diffRegion` and `digestImage` are interpolated from their own source, so the arithmetic here and
 * the arithmetic the tests drive are the same bytes.
 */
export const IN_PAGE_RUNTIME = `(() => {
  const diffRegion = ${diffRegion.toString()};
  const digestImage = ${digestImage.toString()};
  const shots = {};
  const drawn = {};
  const load = async (name) => {
    if (drawn[name] !== undefined) return drawn[name];
    const raw = shots[name];
    if (raw === undefined) throw new Error('no shot named ' + name);
    const image = new Image();
    image.src = 'data:image/png;base64,' + raw;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const image_data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    drawn[name] = image_data;
    return image_data;
  };
  window.__pg = {
    /**
     * Begin a viewport's shots. Called once per viewport, because put() appends and a second
     * viewport's bytes concatenated onto a first would be a corrupt PNG, not a comparison.
     */
    begin() {
      for (const name of Object.keys(shots)) delete shots[name];
      for (const name of Object.keys(drawn)) delete drawn[name];
      return true;
    },
    put(name, chunk) {
      shots[name] = (shots[name] === undefined ? '' : shots[name]) + chunk;
      delete drawn[name];
      return shots[name].length;
    },
    async compare(left, right, regions) {
      let a; let b;
      try {
        a = await load(left);
        b = await load(right);
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) };
      }
      if (a.width !== b.width || a.height !== b.height) {
        return { error: 'the two shots are not the same size: ' + a.width + 'x' + a.height + ' against ' + b.width + 'x' + b.height };
      }
      const out = [];
      for (const region of regions) {
        const rect = region.rect;
        out.push({
          id: region.id,
          kind: region.kind,
          rect: rect,
          stat: diffRegion(a.data, b.data, a.width, rect.x, rect.y, rect.width, rect.height),
        });
      }
      return {
        width: a.width,
        height: a.height,
        whole: diffRegion(a.data, b.data, a.width, 0, 0, a.width, a.height),
        regions: out,
        digests: { left: digestImage(a.data), right: digestImage(b.data) },
        error: null,
      };
    },
    /**
     * One rectangle as a PNG: the left shot's pixels dimmed, every differing pixel in the
     * highlight colour, magnified by an integer factor with nearest-neighbour so a one-pixel rule is
     * visible.
     */
    async crop(left, right, rect, scale) {
      const a = await load(left);
      const b = await load(right);
      const width = Math.max(1, Math.round(rect.width * scale));
      const height = Math.max(1, Math.round(rect.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const out = ctx.createImageData(width, height);
      for (let oy = 0; oy < height; oy++) {
        const sy = rect.y + Math.floor(oy / scale);
        for (let ox = 0; ox < width; ox++) {
          const sx = rect.x + Math.floor(ox / scale);
          const si = (sy * a.width + sx) * 4;
          const di = (oy * width + ox) * 4;
          const worst = Math.max(
            Math.abs(a.data[si] - b.data[si]),
            Math.abs(a.data[si + 1] - b.data[si + 1]),
            Math.abs(a.data[si + 2] - b.data[si + 2]),
            Math.abs(a.data[si + 3] - b.data[si + 3]),
          );
          if (worst > 8) {
            out.data[di] = 255;
            out.data[di + 1] = 51;
            out.data[di + 2] = 102;
            out.data[di + 3] = 255;
          } else {
            out.data[di] = Math.round(a.data[si] * 0.35);
            out.data[di + 1] = Math.round(a.data[si + 1] * 0.35);
            out.data[di + 2] = Math.round(a.data[si + 2] * 0.35);
            out.data[di + 3] = 255;
          }
        }
      }
      ctx.putImageData(out, 0, 0);
      return canvas.toDataURL('image/png');
    },
  };
  return true;
})()`;

export interface RegionStat {
  readonly id: string;
  readonly kind: "chrome" | "content";
  readonly rect: Rect;
  readonly stat: RegionDiff;
}

export interface Comparison {
  /** Why the comparison could not be made, or null when it was. */
  readonly error: string | null;
  readonly width: number;
  readonly height: number;
  readonly whole: RegionDiff;
  readonly regions: readonly RegionStat[];
  /** The two shots' own bytes, so a second capture can be shown identical to the first. */
  readonly digests: { readonly left: string; readonly right: string };
}

export interface DiffPage {
  /** Start a fresh viewport's shots, discarding the previous viewport's. */
  begin(): Promise<boolean>;
  /** Append one base64 chunk of the named shot. */
  put(name: string, base64: string): Promise<number>;
  /** Compare two named shots inside the named rectangles. */
  compare(
    left: string,
    right: string,
    regions: readonly { id: string; kind: "chrome" | "content"; rect: Rect }[],
  ): Promise<Comparison>;
  /** The rectangle as a PNG data URL, left pixels dimmed and differing pixels highlighted. */
  crop(left: string, right: string, rect: Rect, scale: number): Promise<string>;
}
