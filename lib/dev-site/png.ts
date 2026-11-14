/**
 * Just enough PNG for the dev site's badged icons (lib/dev-site/badge.ts):
 * read the app's own 8-bit RGB / RGBA, non-interlaced icons into RGBA pixels,
 * and write RGBA back. No dependency, no binary in the repo: the badged icons
 * are made from public/icon-*.png when they are asked for.
 */
import { deflateSync, inflateSync } from "node:zlib";

export type Rgba = { width: number; height: number; data: Uint8Array };

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** RGBA pixels of an 8-bit truecolour (2) or truecolour+alpha (6) PNG; throws on anything else. */
export function decodePng(png: Uint8Array): Rgba {
  if (!SIGNATURE.every((b, i) => png[i] === b)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let type = 0;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= png.length; ) {
    const len = view.getUint32(p);
    const name = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const body = png.subarray(p + 8, p + 8 + len);
    if (name === "IHDR") {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      const depth = body[8];
      type = body[9]!;
      if (depth !== 8 || (type !== 2 && type !== 6) || body[12] !== 0)
        throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${body[12]})`);
    } else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    p += 12 + len;
  }
  if (!width || !height) throw new Error("PNG without IHDR");
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[out + x - bpp]! : 0;
      const b = y > 0 ? rows[out - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? rows[out - stride + x - bpp]! : 0;
      const v = src[x]!;
      rows[out + x] =
        filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c);
    }
  }
  if (bpp === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    data[j] = rows[i]!;
    data[j + 1] = rows[i + 1]!;
    data[j + 2] = rows[i + 2]!;
    data[j + 3] = 255;
  }
  return { width, height, data };
}

function chunk(name: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** An 8-bit RGBA PNG (each row Sub-filtered). */
export function encodePng({ width, height, data }: Rgba): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1;
    for (let x = 0; x < stride; x++) {
      const cur = data[y * stride + x]!;
      const left = x >= 4 ? data[y * stride + x - 4]! : 0;
      raw[y * (stride + 1) + 1 + x] = (cur - left) & 0xff;
    }
  }
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
