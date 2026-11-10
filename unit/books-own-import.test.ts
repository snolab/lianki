// Import your own book (lib/books/own-import.ts, lib/epub/cover.ts). The
// fixtures are built here: small EPUBs whose text was written for this test
// (no copyrighted text), a one-pixel PNG cover, and plain text files.

import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import {
  bookLang,
  coverKey,
  formatOf,
  importOwnBook,
  OWN_BOOK,
  ownSourceKey,
  parseOwnBook,
  titleFromName,
  type OwnFile,
  type OwnImportDeps,
} from "@/lib/books/own-import";
import { coverMatches, epubCoverRef } from "@/lib/epub/cover";
import { openEpub } from "@/lib/epub/unzip";
import { parseBookMeta } from "@/lib/read/book";

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const CONTAINER = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const xhtml = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;

/** EPUB 3: nav toc, two chapters, a cover marked cover-image; `lang` in the metadata unless null. */
async function epub3(
  opts: { lang?: string | null; cover?: Uint8Array | null; drm?: boolean } = {},
) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", CONTAINER);
  if (opts.drm)
    zip.file(
      "META-INF/encryption.xml",
      `<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>`,
    );
  const lang = opts.lang === undefined ? "de" : opts.lang;
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Der kleine Testgarten</dc:title><dc:creator>Erika Probe</dc:creator>${lang ? `<dc:language>${lang}</dc:language>` : ""}</metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
        <item id="cov" href="img/umschlag.png" media-type="image/png" properties="cover-image"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    xhtml(
      `<nav epub:type="toc"><ol><li><a href="c1.xhtml">Erstes Kapitel</a></li><li><a href="c2.xhtml">Zweites Kapitel</a></li></ol></nav>`,
    ),
  );
  zip.file(
    "OEBPS/c1.xhtml",
    xhtml(
      "<h1>Erstes Kapitel</h1><p>Im Garten wächst ein kleiner Baum, und die Kinder spielen dort jeden Tag.</p>",
    ),
  );
  zip.file(
    "OEBPS/c2.xhtml",
    xhtml(
      "<h1>Zweites Kapitel</h1><p>Am Abend gehen alle nach Hause und erzählen, was sie gesehen haben.</p>",
    ),
  );
  if (opts.cover !== null) zip.file("OEBPS/img/umschlag.png", opts.cover ?? PNG);
  return zip.generateAsync({ type: "uint8array" });
}

/** EPUB 2: the cover named by <meta name="cover">, no toc (a chapter per document). */
async function epub2() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", CONTAINER);
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>A Small Test Book</dc:title><dc:creator>Ann Example</dc:creator><dc:language>en-GB</dc:language><meta name="cover" content="pic"/></metadata>
      <manifest>
        <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
        <item id="pic" href="front.png" media-type="image/png"/>
      </manifest>
      <spine><itemref idref="c1"/></spine></package>`,
  );
  zip.file(
    "OEBPS/one.xhtml",
    xhtml("<h2>One</h2><p>This short page was written for a test and belongs to no one else.</p>"),
  );
  zip.file("OEBPS/front.png", PNG);
  return zip.generateAsync({ type: "uint8array" });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("what a file is", () => {
  test("a zip is an EPUB candidate; .txt/.md or text/plain without NUL bytes is text; else nothing", async () => {
    expect(formatOf("x.epub", "", await epub3())).toBe("epub");
    expect(formatOf("book.txt", "", enc("hello"))).toBe("text");
    expect(formatOf("notes.md", "", enc("# hi"))).toBe("text");
    expect(formatOf("noext", "text/plain", enc("hi"))).toBe("text");
    expect(formatOf("pic.png", "image/png", PNG)).toBeNull();
    expect(formatOf("bin.txt", "", new Uint8Array([1, 0, 2]))).toBeNull();
    expect(formatOf("u16.txt", "", new Uint8Array([0xff, 0xfe, 0x41, 0]))).toBe("text");
  });

  test("a title from a file name; the language as stated, else detected", () => {
    expect(titleFromName("Mein_Buch.epub")).toBe("Mein Buch");
    expect(titleFromName(".txt")).toBe("Book");
    expect(bookLang("EN-gb", [])).toBe("en-GB");
    expect(bookLang("not a tag!", ["Le chat est sur la table et il dort."])).toBe("fr");
    expect(bookLang(undefined, ["猫がテーブルの上で寝ています。"])).toBe("ja");
  });
});

describe("parsing an own book (no AI)", () => {
  test("EPUB 3: title, author, language, chapters, cover", async () => {
    const r = await parseOwnBook(await epub3(), "garten.epub", "application/epub+zip");
    expect(r.format).toBe("epub");
    expect(r.book.title).toBe("Der kleine Testgarten");
    expect(r.book.author).toBe("Erika Probe");
    expect(r.book.lang).toBe("de");
    expect(r.book.chapters.map((c) => c.title)).toEqual(["Erstes Kapitel", "Zweites Kapitel"]);
    expect(r.book.lines.some((l) => l.includes("kleiner Baum"))).toBe(true);
    expect(r.cover?.type).toBe("image/png");
    expect(r.cover?.bytes).toEqual(PNG);
  });

  test("EPUB 2: the cover named in the metadata; one chapter per document", async () => {
    const r = await parseOwnBook(await epub2(), "small.epub", "");
    expect(r.book.title).toBe("A Small Test Book");
    expect(r.book.lang).toBe("en-GB");
    expect(r.cover?.type).toBe("image/png");
    const zip = await openEpub(await epub2());
    expect(await epubCoverRef(zip)).toEqual({ path: "OEBPS/front.png", type: "image/png" });
  });

  test("no stated language: detected from the text", async () => {
    const r = await parseOwnBook(await epub3({ lang: null }), "x.epub", "");
    expect(r.book.lang).toBe("de");
  });

  test("a cover that is not the image it claims, or too big, is left out; the book still imports", async () => {
    const fake = await parseOwnBook(
      await epub3({ cover: enc("<svg onload=alert(1)>") }),
      "x.epub",
      "",
    );
    expect(fake.cover).toBeNull();
    const big = new Uint8Array(OWN_BOOK.maxCoverBytes + 1);
    big.set(PNG);
    expect((await parseOwnBook(await epub3({ cover: big }), "x.epub", "")).cover).toBeNull();
    expect((await parseOwnBook(await epub3({ cover: null }), "x.epub", "")).cover).toBeNull();
    expect(coverMatches("image/svg+xml", enc("<svg/>"))).toBe(false);
    expect(coverMatches("image/png", PNG)).toBe(true);
  });

  test("each cover type is known by its first bytes", () => {
    const pad = (head: number[]) => Uint8Array.from([...head, ...new Array(12).fill(0)]);
    expect(coverMatches("image/jpeg", pad([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(coverMatches("image/gif", pad([0x47, 0x49, 0x46, 0x38]))).toBe(true);
    expect(
      coverMatches("image/webp", pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe(true);
    expect(coverMatches("image/jpeg", PNG)).toBe(false);
    expect(coverMatches("image/gif", PNG)).toBe(false);
    expect(coverMatches("image/webp", PNG)).toBe(false);
  });

  test("no container, no package, or no cover named: no cover", async () => {
    const mem = (files: Record<string, string>) => ({
      list: () => Object.keys(files),
      read: async (p: string) => files[p] ?? null,
    });
    expect(await epubCoverRef(mem({}))).toBeNull();
    expect(await epubCoverRef(mem({ "META-INF/container.xml": CONTAINER }))).toBeNull();
    const opf = (manifest: string) =>
      mem({
        "META-INF/container.xml": CONTAINER,
        "OEBPS/content.opf": `<package><metadata/><manifest>${manifest}</manifest></package>`,
        "OEBPS/images/cover.jpg": "x",
      });
    expect(
      await epubCoverRef(opf(`<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>`)),
    ).toBeNull();
    // Found by its name when nothing marks it.
    expect(
      await epubCoverRef(opf(`<item id="img1" href="images/cover.jpg" media-type="image/jpeg"/>`)),
    ).toEqual({ path: "OEBPS/images/cover.jpg", type: "image/jpeg" });
    // An SVG cover is never taken.
    expect(
      await epubCoverRef(
        opf(
          `<item id="c" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>`,
        ),
      ),
    ).toBeNull();
  });

  test("text: one paragraph per line, the file name as title", async () => {
    const r = await parseOwnBook(
      enc("Erste Zeile des Textes.\n\n  Zweite Zeile, ganz kurz.\r\n"),
      "Meine_Notizen.txt",
      "text/plain",
    );
    expect(r.format).toBe("text");
    expect(r.book.title).toBe("Meine Notizen");
    expect(r.book.lines).toEqual(["Erste Zeile des Textes.", "Zweite Zeile, ganz kurz."]);
    expect(r.book.chapters).toEqual([{ title: "Meine Notizen", start: 0 }]);
    expect(r.cover).toBeNull();
  });

  test("refused with a code: DRM, not a book, no text, too large", async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
    expect(await code(parseOwnBook(await epub3({ drm: true }), "x.epub", ""))).toBe("drm");
    expect(await code(parseOwnBook(PNG, "x.png", "image/png"))).toBe("unsupported");
    const notEpub = new JSZip();
    notEpub.file("hello.txt", "hi");
    expect(
      await code(parseOwnBook(await notEpub.generateAsync({ type: "uint8array" }), "z.zip", "")),
    ).toBe("not-epub");
    expect(await code(parseOwnBook(enc("\n \n"), "empty.txt", ""))).toBe("no-text");
    expect(await code(parseOwnBook(new Uint8Array(OWN_BOOK.maxFileBytes + 1), "big.txt", ""))).toBe(
      "too-large",
    );
  });
});

describe("importing a stored file as a book", () => {
  const FILE_ID = "0123456789abcdef0123";
  function deps(file: OwnFile | null, bytes: Uint8Array) {
    const saved: { userId: string; title: string; content: string; key: string }[] = [];
    const covers: { key: string; type: string }[] = [];
    const dropped: string[] = [];
    const books = new Map<string, string>();
    const d: OwnImportDeps = {
      file: async () => file,
      bytes: async () => bytes,
      find: async (u, k) => (books.has(`${u}|${k}`) ? { id: books.get(`${u}|${k}`)! } : null),
      save: async (userId, title, content, _lines, _hash, key) => {
        const id = `m${saved.length + 1}`;
        saved.push({ userId, title, content, key });
        books.set(`${userId}|${key}`, id);
        return { id };
      },
      putCover: async (key, _b, type) => {
        covers.push({ key, type });
      },
      dropFile: async (_u, id) => {
        dropped.push(id);
      },
    };
    return { d, saved, covers, dropped };
  }
  const file = (over: Partial<OwnFile> = {}): OwnFile => ({
    id: FILE_ID,
    ownerId: "u1",
    name: "garten.epub",
    type: "application/epub+zip",
    source: "books",
    r2Key: "inbox/u1/x",
    ...over,
  });

  test("the book is saved once per file, keyed file:<id>, with its cover beside the file", async () => {
    const { d, saved, covers } = deps(file(), await epub3());
    const first = await importOwnBook("u1", FILE_ID, d);
    expect(first).toEqual({ ok: true, id: "m1", existing: false });
    expect(saved[0].key).toBe(ownSourceKey(FILE_ID));
    expect(covers).toEqual([{ key: coverKey("u1", FILE_ID), type: "image/png" }]);
    const meta = parseBookMeta(saved[0].content)!;
    expect(meta.source).toBe("epub");
    expect(meta.lang).toBe("de");
    expect(meta.author).toBe("Erika Probe");
    expect(meta.cover).toBe(1);
    expect(await importOwnBook("u1", FILE_ID, d)).toEqual({ ok: true, id: "m1", existing: true });
    expect(saved).toHaveLength(1);
  });

  test("another account's file, or one from another folder, does not exist", async () => {
    for (const f of [file({ ownerId: "u2" }), file({ source: "import" }), null]) {
      const { d, saved } = deps(f, await epub3());
      expect(await importOwnBook("u1", FILE_ID, d)).toEqual({
        ok: false,
        status: 404,
        error: "not-found",
      });
      expect(saved).toHaveLength(0);
    }
  });

  test("a file that is not a readable book is removed again, with the reason", async () => {
    const { d, saved, dropped } = deps(file(), await epub3({ drm: true }));
    expect(await importOwnBook("u1", FILE_ID, d)).toEqual({ ok: false, status: 422, error: "drm" });
    expect(dropped).toEqual([FILE_ID]);
    expect(saved).toHaveLength(0);
  });

  test("a text file becomes a text book", async () => {
    const { d, saved } = deps(file({ name: "notes.txt", type: "text/plain" }), enc("Eine Zeile."));
    expect((await importOwnBook("u1", FILE_ID, d)).ok).toBe(true);
    expect(parseBookMeta(saved[0].content)!.source).toBe("text");
  });
});
