/**
 * A dependency-free PNG reader and pixel comparison, so a screenshot number is reproducible without
 * a browser and without an image library.
 *
 * The contract's pixel figure is information rather than a pass condition, and a number nobody can
 * recompute is not information. This module turns two committed PNGs into one comparison a reviewer
 * can rerun: how many pixels differ at all, and the mean absolute channel difference.
 */

import { inflateSync } from "node:zlib";

export interface Rgba {
  readonly width: number;
  readonly height: number;
  /** RGBA, four bytes per pixel, row major. */
  readonly data: Buffer;
}

export interface PixelDiff {
  readonly width: number;
  readonly height: number;
  /** Pixels where at least one channel differs. */
  readonly differing: number;
  readonly total: number;
  /** `differing / total`, 0 to 1. */
  readonly share: number;
  /** Mean absolute channel difference, 0 to 255. */
  readonly meanAbsolute: number;
}

const CHANNELS: Record<number, number> = { 2: 3, 6: 4 };

/** Decode an 8-bit truecolour PNG (colour types 2 and 6). Anything else is refused by name. */
export function decodePng(buffer: Buffer): Rgba {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Buffer[] = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body.readUInt8(8);
      const colorType = body.readUInt8(9);
      const interlace = body.readUInt8(12);
      if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} is not supported`);
      if (interlace !== 0) throw new Error("interlaced PNG is not supported");
      const found = CHANNELS[colorType];
      if (found === undefined) throw new Error(`PNG colour type ${colorType} is not supported`);
      channels = found;
    } else if (type === "IDAT") {
      parts.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error("PNG has no IHDR");

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const data = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(y * (stride + 1));
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    unfilter(filter, line, previous, channels);
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      data[to] = line[from] ?? 0;
      data[to + 1] = line[from + 1] ?? 0;
      data[to + 2] = line[from + 2] ?? 0;
      data[to + 3] = channels === 4 ? (line[from + 3] ?? 255) : 255;
    }
    previous = line;
  }
  return { width, height, data };
}

/** One scanline, in place. The five filters the PNG specification defines for 8-bit images. */
function unfilter(filter: number, line: Buffer, previous: Buffer, channels: number): void {
  const stride = line.length;
  for (let i = 0; i < stride; i++) {
    const left = i >= channels ? (line[i - channels] ?? 0) : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0;
    const value = line[i] ?? 0;
    let restored: number;
    switch (filter) {
      case 0:
        continue;
      case 1:
        restored = value + left;
        break;
      case 2:
        restored = value + up;
        break;
      case 3:
        restored = value + ((left + up) >> 1);
        break;
      case 4:
        restored = value + paeth(left, up, upLeft);
        break;
      default:
        throw new Error(`PNG filter ${filter} is not defined`);
    }
    line[i] = restored & 0xff;
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
}

/** The differing-pixel share and the mean absolute channel difference between two PNGs. */
export function diffPng(left: Buffer, right: Buffer): PixelDiff {
  const a = decodePng(left);
  const b = decodePng(right);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`cannot compare ${a.width}x${a.height} with ${b.width}x${b.height}`);
  }
  const total = a.width * a.height;
  let differing = 0;
  let sum = 0;
  for (let i = 0; i < total; i++) {
    const at = i * 4;
    const dr = Math.abs((a.data[at] ?? 0) - (b.data[at] ?? 0));
    const dg = Math.abs((a.data[at + 1] ?? 0) - (b.data[at + 1] ?? 0));
    const db = Math.abs((a.data[at + 2] ?? 0) - (b.data[at + 2] ?? 0));
    const da = Math.abs((a.data[at + 3] ?? 0) - (b.data[at + 3] ?? 0));
    if (dr !== 0 || dg !== 0 || db !== 0 || da !== 0) differing += 1;
    sum += dr + dg + db + da;
  }
  return {
    width: a.width,
    height: a.height,
    differing,
    total,
    share: differing / total,
    meanAbsolute: sum / (total * 4),
  };
}
