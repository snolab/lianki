// An EPUB's cover image: where it is and what it is, read from the package
// (OPF). EPUB 3 marks it in the manifest (`properties="cover-image"`), EPUB 2
// names it in the metadata (`<meta name="cover" content="<item id>"/>`); else
// an image item whose id or file name says "cover". Raster images only (JPEG,
// PNG, GIF, WebP): an SVG can carry script and is never taken. Pure: reads
// through `EpubArchive`.

import { resolvePath, type EpubArchive } from "./parse";
import { find, findAll, parseXml } from "./xml";

/** The image types a cover may have, and how each file starts (its magic bytes). */
export const COVER_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  "image/webp": (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57,
};

/** The cover's path in the archive and its declared type; null when the book names none. */
export async function epubCoverRef(
  zip: EpubArchive,
): Promise<{ path: string; type: string } | null> {
  const names = new Map(zip.list().map((n) => [n.toLowerCase(), n]));
  const entry = (p: string) => names.get(p.toLowerCase());
  const containerPath = entry("META-INF/container.xml");
  const container = containerPath ? await zip.read(containerPath) : null;
  if (!container) return null;
  const rootfile = findAll(parseXml(container), "rootfile")[0];
  const opfPath = rootfile?.attrs["full-path"] ? entry(rootfile.attrs["full-path"]) : undefined;
  const opfXml = opfPath ? await zip.read(opfPath) : null;
  if (!opfPath || !opfXml) return null;
  const opf = parseXml(opfXml);
  const items = findAll(find(opf, "manifest") ?? opf, "item").map((it) => ({
    id: it.attrs.id ?? "",
    href: it.attrs.href ?? "",
    type: (it.attrs["media-type"] ?? "").toLowerCase(),
    props: it.attrs.properties ?? "",
  }));
  const metadata = find(opf, "metadata");
  const metaCover = metadata
    ? findAll(metadata, "meta").find((m) => (m.attrs.name ?? "").toLowerCase() === "cover")?.attrs
        .content
    : undefined;
  const pick =
    items.find((i) => /(^|\s)cover-image(\s|$)/.test(i.props)) ??
    (metaCover ? items.find((i) => i.id === metaCover) : undefined) ??
    items.find((i) => i.type.startsWith("image/") && /cover/i.test(`${i.id} ${i.href}`));
  if (!pick || !Object.hasOwn(COVER_TYPES, pick.type)) return null;
  const path = resolvePath(opfPath, pick.href);
  const real = path ? entry(path) : undefined;
  return real ? { path: real, type: pick.type } : null;
}

/** The bytes are the image type they claim (never trust the manifest alone). */
export function coverMatches(type: string, bytes: Uint8Array): boolean {
  return Object.hasOwn(COVER_TYPES, type) && bytes.length > 8 && COVER_TYPES[type](bytes);
}
