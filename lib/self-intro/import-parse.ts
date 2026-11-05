/**
 * The /self-intro import's file parsers (docs/self-intro-import.md). They run
 * in the browser: a PDF, a Word file, a zip or a text file becomes text on the
 * user's device, and only that text goes to the server. An image stays an
 * image (shrunk), for the model to read — photos of handwritten notes too.
 *
 * Recognition is one list keyed by MIME type, then by extension; nothing else
 * looks at the format. Adding a format is adding an entry here. No parser
 * stores anything: bytes are read, turned into a part, and dropped.
 */
import { IMPORT } from "./import-config";

export type ImportPart =
  | { kind: "text"; name: string; text: string }
  | { kind: "image"; name: string; dataUrl: string };

/** A picked file (a browser `File`, or a stand-in in tests). */
export type FileLike = {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** What a parser may need from the page (injected, so tests run without a DOM). */
export type ParseDeps = {
  /** Shrink an image to `IMPORT.imageMaxSide` and return it as a data URL (canvas, in the page). */
  shrinkImage?: (file: FileLike) => Promise<string>;
};

export class ImportFileError extends Error {
  constructor(
    readonly code: "unsupported" | "too-large" | "unreadable" | "empty",
    readonly file: string,
  ) {
    super(code);
  }
}

export type Parser = {
  id: string;
  mimes: readonly string[];
  /** Lower-case, without the dot. */
  exts: readonly string[];
  parse(file: FileLike, deps: ParseDeps): Promise<ImportPart[]>;
};

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** Bytes as text: a BOM picks UTF-16, else UTF-8 (bad sequences become U+FFFD). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Markup (HTML, XML) as plain text: block ends become line breaks, tags go. */
export function markupToText(markup: string): string {
  return decodeEntities(
    markup
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\/(p|div|li|h[1-6]|tr|w:p)\s*>|<br\s*\/?>|<w:br\s*\/?>|<w:tab\s*\/?>/gi, (t) =>
        /tab/i.test(t) ? "\t" : "\n",
      )
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const bytesOf = async (f: FileLike) => new Uint8Array(await f.arrayBuffer());
const textPart = (name: string, text: string): ImportPart[] =>
  text.trim() ? [{ kind: "text", name, text: text.trim() }] : [];

/** A zip's text entries (a Word file is one), with the EPUB import's zip-bomb limits. */
async function zipTexts(bytes: Uint8Array, pick: (entry: string) => boolean) {
  const { openEpub } = await import("@/lib/epub/unzip");
  const zip = await openEpub(bytes);
  const out: { name: string; text: string }[] = [];
  for (const name of zip.list().filter(pick).sort()) {
    const text = await zip.read(name);
    if (text) out.push({ name, text });
  }
  return out;
}

const TEXT_EXTS = ["txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "vcf", "log"];
const HTML_EXTS = ["html", "htm", "xhtml", "xml"];

export const PARSERS: readonly Parser[] = [
  {
    id: "pdf",
    mimes: ["application/pdf"],
    exts: ["pdf"],
    async parse(f) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(await bytesOf(f));
      try {
        const { text } = await extractText(pdf, { mergePages: true });
        return textPart(f.name, text);
      } finally {
        void pdf.cleanup();
      }
    },
  },
  {
    id: "docx",
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    exts: ["docx"],
    async parse(f) {
      const parts = await zipTexts(await bytesOf(f), (n) =>
        /^word\/(document|header\d*|footer\d*)\.xml$/.test(n),
      );
      // The body first, then headers and footers (where a CV often keeps contact lines).
      parts.sort(
        (a, b) => Number(b.name === "word/document.xml") - Number(a.name === "word/document.xml"),
      );
      return textPart(f.name, parts.map((p) => markupToText(p.text)).join("\n\n"));
    },
  },
  {
    id: "zip",
    mimes: ["application/zip", "application/x-zip-compressed"],
    exts: ["zip"],
    // A profile export (a zip of CSV, JSON or HTML files): every text entry, by the same list.
    async parse(f) {
      const parts = await zipTexts(await bytesOf(f), (n) => {
        const ext = extOf(n);
        return TEXT_EXTS.includes(ext) || HTML_EXTS.includes(ext);
      });
      return parts.flatMap((p) =>
        textPart(
          `${f.name}/${p.name}`,
          HTML_EXTS.includes(extOf(p.name)) ? markupToText(p.text) : p.text,
        ),
      );
    },
  },
  {
    id: "image",
    mimes: ["image/"],
    exts: ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif", "bmp"],
    async parse(f, deps) {
      if (!deps.shrinkImage) throw new ImportFileError("unsupported", f.name);
      const dataUrl = await deps.shrinkImage(f);
      if (dataUrl.length > IMPORT.maxImageChars) throw new ImportFileError("too-large", f.name);
      return [{ kind: "image", name: f.name, dataUrl }];
    },
  },
  {
    id: "html",
    mimes: ["text/html", "application/xhtml+xml", "application/xml", "text/xml"],
    exts: HTML_EXTS,
    async parse(f) {
      return textPart(f.name, markupToText(decodeText(await bytesOf(f))));
    },
  },
  {
    id: "text",
    mimes: ["text/", "application/json"],
    exts: TEXT_EXTS,
    async parse(f) {
      return textPart(f.name, decodeText(await bytesOf(f)));
    },
  },
];

/** The parser for a file: its MIME type first (a prefix ending in "/" matches a family), else its extension. */
export function pickParser(name: string, type: string): Parser | null {
  const mime = type.split(";")[0]!.trim().toLowerCase();
  if (mime && mime !== "application/octet-stream") {
    const byMime = PARSERS.find((p) =>
      p.mimes.some((m) => (m.endsWith("/") ? mime.startsWith(m) : mime === m)),
    );
    if (byMime) return byMime;
  }
  const ext = extOf(name);
  return (ext && PARSERS.find((p) => p.exts.includes(ext))) || null;
}

/** One file → its parts. Throws `ImportFileError` with a code the page shows. */
export async function parseImportFile(file: FileLike, deps: ParseDeps = {}): Promise<ImportPart[]> {
  if (file.size > IMPORT.maxFileBytes) throw new ImportFileError("too-large", file.name);
  const parser = pickParser(file.name, file.type);
  if (!parser) throw new ImportFileError("unsupported", file.name);
  let parts: ImportPart[];
  try {
    parts = await parser.parse(file, deps);
  } catch (e) {
    if (e instanceof ImportFileError) throw e;
    if (e && typeof e === "object" && "code" in e && e.code === "too-large")
      throw new ImportFileError("too-large", file.name);
    throw new ImportFileError("unreadable", file.name);
  }
  if (!parts.length) throw new ImportFileError("empty", file.name);
  return parts;
}

/** What the page sends: every text in one string (each file under its name), and the images. */
export type ImportPayload = { text: string; images: string[]; truncated: boolean };

/** The typed text and the files' parts, merged and capped (`maxTextChars`, `maxImages`). */
export function mergeImport(typed: string, parts: ImportPart[]): ImportPayload {
  const blocks: string[] = [];
  if (typed.trim()) blocks.push(typed.trim());
  for (const p of parts) if (p.kind === "text") blocks.push(`--- ${p.name} ---\n${p.text}`);
  let text = blocks.join("\n\n");
  let truncated = false;
  if (text.length > IMPORT.maxTextChars) {
    text = text.slice(0, IMPORT.maxTextChars);
    truncated = true;
  }
  const all = parts.flatMap((p) => (p.kind === "image" ? [p.dataUrl] : []));
  if (all.length > IMPORT.maxImages) truncated = true;
  return { text, images: all.slice(0, IMPORT.maxImages), truncated };
}
