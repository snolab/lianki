#!/usr/bin/env bun
/**
 * Build and package the Chrome extension, end to end.
 *
 *   bun scripts/build-extension.ts            # -> packages/ext/dist + the upload zip
 *   bun scripts/build-extension.ts --out=/tmp/x.zip
 *
 * Exists because the first hand-built package would have been rejected by the
 * Chrome Web Store for three separate reasons, all of them the kind a script
 * gets right every time and a human gets right once:
 *
 *   - no icons at all (the store requires a 128px one)
 *   - a manifest version that had drifted from the product (2.23.17 vs 2.23.24)
 *   - a zip assembled by hand, so its contents depended on who ran which command
 *
 * The icons are GENERATED, not committed: a checked-in PNG is a binary nobody
 * reviews and everybody forgets to update. Drawing them here means the mark is
 * defined in code, is reproducible, and changes in a readable diff.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import JSZip from "jszip";

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "packages/ext");
const DIST = join(EXT, "dist");

const args = Bun.argv.slice(2);
const outArg = args.find((a) => a.startsWith("--out="));
const ZIP_OUT = outArg ? outArg.slice("--out=".length) : join(DIST, "lianki-extension.zip");

// ── PNG encoding ─────────────────────────────────────────────────────────────

/** Minimal RGBA PNG encoder. No dependency does this for us and it is ~30 lines. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4);
    Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }

  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ── the mark ─────────────────────────────────────────────────────────────────

type RGB = [number, number, number];
const INDIGO: RGB = [79, 70, 229]; // #4f46e5, the app's accent
const WHITE: RGB = [255, 255, 255];

/** Signed-distance helper: inside a rounded rectangle? */
const inRoundRect = (
  x: number,
  y: number,
  rx: number,
  ry: number,
  w: number,
  h: number,
  r: number,
) => {
  const dx = Math.max(rx - x, 0, x - (rx + w));
  const dy = Math.max(ry - y, 0, y - (ry + h));
  if (dx === 0 && dy === 0) return true;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/**
 * Two offset cards — the shape reads as "flashcards" even at 16px, where a
 * glyph or wordmark turns to mush.
 *
 * The separation between the cards is a *drawn indigo gap*, not a punched-out
 * halo: the first attempt subtracted an oversized front silhouette from the
 * back card and left only a sliver, which at 16px looked like a stray line
 * rather than a second card. The gap is also floored at one final-resolution
 * pixel, because a purely proportional gap vanishes in the 16px downsample.
 *
 * Drawn at 4x and box-filtered down — the cheapest anti-aliasing that still
 * looks deliberate rather than jagged.
 */
function drawIcon(size: number): Uint8Array {
  const S = 4;
  const N = size * S;
  const hi = new Uint8Array(N * N * 4);

  const put = (i: number, [r, g, b]: RGB, a = 255) => {
    hi[i] = r;
    hi[i + 1] = g;
    hi[i + 2] = b;
    hi[i + 3] = a;
  };

  // Card geometry, as fractions of the tile. The pair is centred as a unit.
  const cw = 0.42 * N;
  const ch = 0.5 * N;
  const r = 0.075 * N;
  // Offset large enough that the back card still shows ~2px at 16px after the
  // gap is subtracted. At 0.12N it degraded to a 1px sliver that read as noise.
  const backX = 0.37 * N;
  const backY = 0.12 * N;
  const frontX = 0.21 * N;
  const frontY = 0.36 * N;
  const gap = Math.max(0.03 * N, S); // >= 1px after downsampling

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      if (!inRoundRect(x, y, 0, 0, N - 1, N - 1, N * 0.22)) continue;
      put(i, INDIGO);

      // Back card first, dimmed so the front reads as nearer.
      if (inRoundRect(x, y, backX, backY, cw, ch, r)) put(i, WHITE, 160);
      // Indigo gap, then the solid front card on top of it.
      if (inRoundRect(x, y, frontX - gap, frontY - gap, cw + gap * 2, ch + gap * 2, r + gap))
        put(i, INDIGO);
      if (inRoundRect(x, y, frontX, frontY, cw, ch, r)) put(i, WHITE);
    }
  }

  // box-filter down to the requested size
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r2 = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * N + (x * S + sx)) * 4;
          const al = hi[i + 3]!;
          r2 += hi[i]! * al;
          g += hi[i + 1]! * al;
          b += hi[i + 2]! * al;
          a += al;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r2 / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / (S * S));
    }
  }
  return out;
}

// ── build ────────────────────────────────────────────────────────────────────

/**
 * The product version, from the one place that already tracks it. The manifest
 * had drifted seven patches behind; deriving it means that cannot recur, and
 * the store's "version must increase" rule is satisfied by the same bump the
 * userscript already requires.
 */
function productVersion(): string {
  const src = readFileSync(join(ROOT, "lib/userscript-version.ts"), "utf8");
  const m = src.match(/LIANKI_USERSCRIPT_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("could not read LIANKI_USERSCRIPT_VERSION");
  return m[1]!;
}

const SIZES = [16, 32, 48, 128];

async function main() {
  mkdirSync(DIST, { recursive: true });

  // 1. icons
  for (const s of SIZES) {
    writeFileSync(join(DIST, `icon${s}.png`), encodePng(s, s, drawIcon(s)));
  }
  console.log(`  icons:    ${SIZES.map((s) => `${s}px`).join(", ")}`);

  // 2. content script
  const built = await Bun.build({
    entrypoints: [join(EXT, "src/content.ts")],
    target: "browser",
    minify: true,
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  const code = await built.outputs[0]!.text();
  writeFileSync(join(DIST, "content.js"), code);
  console.log(`  content:  ${(code.length / 1024).toFixed(1)} KB`);

  // 3. manifest, with the version and icons filled in
  const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
  manifest.version = productVersion();
  manifest.icons = Object.fromEntries(SIZES.map((s) => [s, `icon${s}.png`]));
  manifest.action = { ...(manifest.action ?? {}), default_icon: manifest.icons };
  writeFileSync(join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  manifest: v${manifest.version}`);

  // 4. zip
  const zip = new JSZip();
  zip.file("manifest.json", readFileSync(join(DIST, "manifest.json")));
  zip.file("content.js", readFileSync(join(DIST, "content.js")));
  for (const s of SIZES) zip.file(`icon${s}.png`, readFileSync(join(DIST, `icon${s}.png`)));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  mkdirSync(dirname(ZIP_OUT), { recursive: true });
  writeFileSync(ZIP_OUT, buf);
  console.log(`  zip:      ${ZIP_OUT} (${(buf.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
