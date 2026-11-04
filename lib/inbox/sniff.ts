/**
 * What an uploaded file really is, from its first bytes: the stored type is
 * this, never the browser's claim. Anything unknown is
 * application/octet-stream; text that looks like HTML, SVG or XML is stored
 * as text/plain, so nothing a user sent can ever render as a page.
 * Executables (PE, ELF, Mach-O, shell scripts) are flagged: still stored
 * (the owner may want to look), and only ever downloaded as an attachment.
 */

/** Bytes read from the head of a file to decide. */
export const SNIFF_BYTES = 512;

export type Sniffed = { type: string; executable?: true };

const ascii = (b: Uint8Array, at: number, s: string) =>
  b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const bytes = (b: Uint8Array, at: number, xs: number[]) =>
  b.length >= at + xs.length && xs.every((x, i) => b[at + i] === x);

/** ISO-BMFF (ftyp) brands: images, then audio, then video. */
function ftyp(b: Uint8Array): string | null {
  if (!ascii(b, 4, "ftyp")) return null;
  const brand = String.fromCharCode(...b.slice(8, 12));
  if (/^(avif|avis)$/.test(brand)) return "image/avif";
  if (/^(heic|heix|heim|heis|mif1|msf1)$/.test(brand)) return "image/heic";
  if (/^M4A |^M4B /.test(brand)) return "audio/mp4";
  if (/^qt {2}/.test(brand)) return "video/quicktime";
  return "video/mp4";
}

/** Text: valid UTF-8 with no NUL and few control characters. */
function isText(b: Uint8Array): boolean {
  if (!b.length) return true;
  if (b.includes(0)) return false;
  let s: string;
  try {
    // A multi-byte character cut at the end of the head is fine.
    s = new TextDecoder("utf-8", { fatal: true }).decode(b.slice(0, cutUtf8(b)));
  } catch {
    return false;
  }
  const ctl = [...s].filter((c) => /[\u0000-\u0008\u000e-\u001f\u007f]/.test(c)).length;
  return ctl <= s.length / 100;
}
/** The length of b without a trailing partial UTF-8 sequence. */
function cutUtf8(b: Uint8Array): number {
  let i = b.length;
  for (let k = 1; k <= 3 && i - k >= 0; k++) {
    const x = b[i - k]!;
    if ((x & 0xc0) === 0x80) continue;
    const need = x >= 0xf0 ? 4 : x >= 0xe0 ? 3 : x >= 0xc0 ? 2 : 1;
    return need > k ? i - k : i;
  }
  return i;
}

/** Text types a declared type may narrow plain text to; anything else is text/plain. */
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/** The stored type of a file whose first bytes are `head`; `declared` only narrows plain text. */
export function sniff(head: Uint8Array, declared = ""): Sniffed {
  const b = head;
  if (bytes(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: "image/png" };
  if (bytes(b, 0, [0xff, 0xd8, 0xff])) return { type: "image/jpeg" };
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return { type: "image/gif" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return { type: "image/webp" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return { type: "audio/wav" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "AVI ")) return { type: "video/x-msvideo" };
  const iso = ftyp(b);
  if (iso) return { type: iso };
  if (bytes(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { type: "video/webm" };
  if (ascii(b, 0, "OggS")) return { type: "audio/ogg" };
  if (ascii(b, 0, "fLaC")) return { type: "audio/flac" };
  if (ascii(b, 0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 && b.length > 2))
    return { type: "audio/mpeg" };
  if (ascii(b, 0, "%PDF-")) return { type: "application/pdf" };
  if (bytes(b, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes(b, 0, [0x50, 0x4b, 0x05, 0x06]))
    return { type: "application/zip" };
  if (bytes(b, 0, [0x1f, 0x8b])) return { type: "application/gzip" };
  // Executables: stored as opaque bytes, flagged.
  if (ascii(b, 0, "MZ") || bytes(b, 0, [0x7f, 0x45, 0x4c, 0x46]))
    return { type: "application/octet-stream", executable: true };
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(u32(b)))
    return { type: "application/octet-stream", executable: true };
  if (ascii(b, 0, "#!")) return { type: "text/plain", executable: true };
  if (isText(b)) {
    const d = declared.toLowerCase().split(";")[0]!.trim();
    // Markup never keeps its type: text/plain, so it can never render.
    return { type: TEXT_TYPES.has(d) ? d : "text/plain" };
  }
  return { type: "application/octet-stream" };
}
const u32 = (b: Uint8Array) =>
  b.length >= 4 ? ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0 : 0;

/** Image types served inline (an <img> in the chat); every other type downloads as an attachment. */
export const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
