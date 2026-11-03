import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { EpubError, parseEpub, resolvePath, type EpubArchive } from "@/lib/epub/parse";
import { EPUB_LIMITS, importEpub, openEpub } from "@/lib/epub/unzip";
import { decodeEntities, parseXml, textOf } from "@/lib/epub/xml";
import { BOOK_LIMITS, bookMetaOf, chapterAt, checkBook, parseBookMeta } from "@/lib/read/book";

// The /read EPUB import (lib/epub/). Fixture: Project Gutenberg #7256, O. Henry,
// "The Gift of the Magi" (1905) — public domain in the USA; the file is the
// unmodified Project Gutenberg EPUB 3 and carries the Project Gutenberg License.
const FIXTURE = "unit/fixtures/epub/pg7256-gift-of-the-magi.epub";

const CONTAINER = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function mem(files: Record<string, string>): EpubArchive {
  return { list: () => Object.keys(files), read: async (p) => files[p] ?? null };
}

const xhtml = (body: string, title = "") =>
  `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title><style>p{color:red}</style></head><body>${body}</body></html>`;

// EPUB 2: NCX toc, two chapter files.
const epub2 = {
  mimetype: "application/epub+zip",
  "META-INF/container.xml": CONTAINER,
  "OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Le Livre</dc:title><dc:creator>Une Autrice</dc:creator><dc:language>fr</dc:language></metadata>
    <manifest>
      <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
      <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
      <item id="img" href="img/a.png" media-type="image/png"/>
    </manifest>
    <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
  "OEBPS/toc.ncx": `<ncx><navMap>
    <navPoint id="a"><navLabel><text>Chapitre I</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
    <navPoint id="b"><navLabel><text>Chapitre II</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
  </navMap></ncx>`,
  "OEBPS/text/ch1.xhtml": xhtml(
    `<h1>I</h1><p>Lorsque j’avais six ans j’ai vu, une fois, une magnifique image.<a href="#n1" epub:type="noteref">1</a></p>
     <p>Ça représentait un serpent&nbsp;boa &amp; un fauve.<script>alert(1)</script></p><img src="../img/a.png"/>`,
  ),
  "OEBPS/text/ch2.xhtml": xhtml(
    `<h2>II</h2><p>J’ai ainsi vécu seul, sans personne avec qui parler.</p><ul><li>un</li><li>deux</li></ul>`,
  ),
};

// EPUB 3: nav toc, both chapters in one file, split by fragment.
const epub3 = {
  "META-INF/container.xml": CONTAINER,
  "OEBPS/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book Three</dc:title></metadata>
    <manifest>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="all" href="all.xhtml" media-type="application/xhtml+xml"/>
      <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>
    </manifest>
    <spine><itemref idref="all"/><itemref idref="notes" linear="no"/></spine></package>`,
  "OEBPS/nav.xhtml": xhtml(
    `<nav epub:type="landmarks"><ol><li><a href="all.xhtml">Start</a></li></ol></nav>
     <nav epub:type="toc"><ol><li><a href="all.xhtml#one">One</a></li><li><a href="all.xhtml#two">Two</a></li></ol></nav>`,
  ),
  "OEBPS/all.xhtml": xhtml(
    `<section id="one"><h2>One</h2><p>First para.</p><p>Second<br/>line.</p></section>
     <section id="two"><h2>Two</h2><p>Café au lait.</p><aside epub:type="footnote"><p>A note.</p></aside></section>`,
  ),
  "OEBPS/notes.xhtml": xhtml(`<p>Not in the linear spine.</p>`),
};

describe("xml", () => {
  it("decodes entities once and never expands a DTD", () => {
    expect(decodeEntities("&amp;lt; &#233; &#x263A; &eacute; &unknown;")).toBe(
      "&lt; é ☺ é &unknown;",
    );
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><p>&lol2;</p>`;
    expect(textOf(parseXml(bomb))).toBe("&lol2;");
    const xxe = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><p>&xxe;</p>`;
    expect(textOf(parseXml(xxe))).toBe("&xxe;");
  });
  it("tolerates malformed markup", () => {
    expect(textOf(parseXml("<p>a < b <i>c</p></div>d"))).toBe("a < b cd");
  });
});

describe("resolvePath", () => {
  it("resolves relative hrefs and refuses to leave the archive", () => {
    expect(resolvePath("OEBPS/content.opf", "text/ch%201.xhtml#x")).toBe("OEBPS/text/ch 1.xhtml");
    expect(resolvePath("OEBPS/text/a.xhtml", "../img/b.png")).toBe("OEBPS/img/b.png");
    expect(resolvePath("OEBPS/content.opf", "../../etc/passwd")).toBeNull();
    expect(resolvePath("OEBPS/content.opf", "https://example.com/x")).toBeNull();
  });
});

describe("parseEpub", () => {
  it("EPUB 2: metadata, NCX chapters, paragraphs; drops scripts, images, noterefs", async () => {
    const b = await parseEpub(mem(epub2));
    expect(b.title).toBe("Le Livre");
    expect(b.author).toBe("Une Autrice");
    expect(b.lang).toBe("fr");
    expect(b.lines).toEqual([
      "I",
      "Lorsque j’avais six ans j’ai vu, une fois, une magnifique image.",
      "Ça représentait un serpent boa & un fauve.",
      "II",
      "J’ai ainsi vécu seul, sans personne avec qui parler.",
      "un",
      "deux",
    ]);
    expect(b.chapters).toEqual([
      { title: "Chapitre I", start: 0 },
      { title: "Chapitre II", start: 3 },
    ]);
    expect(b.headings).toEqual([0, 3]);
  });

  it("EPUB 3: nav toc with fragments in one file, br splits, NFC, footnotes and non-linear items dropped", async () => {
    const b = await parseEpub(mem(epub3));
    expect(b.title).toBe("Book Three");
    expect(b.lines).toEqual(["One", "First para.", "Second", "line.", "Two", "Café au lait."]);
    expect(b.lines[5]).toBe("Café au lait.".normalize("NFC"));
    expect(b.chapters).toEqual([
      { title: "One", start: 0 },
      { title: "Two", start: 4 },
    ]);
  });

  it("without a toc, each spine document is a chapter titled by its first heading", async () => {
    const files: Record<string, string> = { ...epub2 };
    delete files["OEBPS/toc.ncx"];
    const b = await parseEpub(mem(files));
    expect(b.chapters).toEqual([
      { title: "I", start: 0 },
      { title: "II", start: 3 },
    ]);
  });

  it("refuses DRM; allows font obfuscation only", async () => {
    const enc = (
      alg: string,
    ) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
      <enc:EncryptedData><enc:EncryptionMethod Algorithm="${alg}"/><enc:CipherData><enc:CipherReference URI="OEBPS/x"/></enc:CipherData></enc:EncryptedData></encryption>`;
    const font = { ...epub2, "META-INF/encryption.xml": enc("http://www.idpf.org/2008/embedding") };
    expect((await parseEpub(mem(font))).title).toBe("Le Livre");
    const adobeFont = {
      ...epub2,
      "META-INF/encryption.xml": enc("http://ns.adobe.com/pdf/enc#RC"),
    };
    expect((await parseEpub(mem(adobeFont))).title).toBe("Le Livre");
    for (const files of [
      { ...epub2, "META-INF/encryption.xml": enc("http://www.w3.org/2001/04/xmlenc#aes128-cbc") },
      { ...epub2, "META-INF/rights.xml": "<rights/>" },
      { ...epub2, "META-INF/sinf.xml": "<sinf/>" },
      { ...epub2, "META-INF/license.lcpl": "{}" },
    ]) {
      const err = await parseEpub(mem(files)).catch((e) => e);
      expect(err).toBeInstanceOf(EpubError);
      expect(err.code).toBe("drm");
    }
  });

  it("not an EPUB, or no text", async () => {
    expect((await parseEpub(mem({ "a.txt": "x" })).catch((e) => e)).code).toBe("not-epub");
    const empty = {
      ...epub2,
      "OEBPS/text/ch1.xhtml": xhtml("<img/>"),
      "OEBPS/text/ch2.xhtml": xhtml(""),
    };
    expect((await parseEpub(mem(empty)).catch((e) => e)).code).toBe("no-text");
  });
});

describe("the Project Gutenberg fixture (real EPUB 3 + NCX)", () => {
  it("parses title, author, chapters from the nav toc", async () => {
    const b = await importEpub(readFileSync(FIXTURE));
    expect(b.title).toBe("The Gift of the Magi");
    expect(b.author).toBe("O. Henry");
    expect(b.lang).toBe("en");
    expect(b.lines).toContain(
      "One dollar and eighty-seven cents. That was all. And sixty cents of it was in pennies. Pennies saved one and two at a time by bulldozing the grocer and the vegetable man and the butcher until one’s cheeks burned with the silent imputation of parsimony that such close dealing implied. Three times Della counted it. One dollar and eighty-seven cents. And the next day would be Christmas.",
    );
    expect(b.chapters.map((c) => c.title)).toEqual([
      "The Gift of the Magi",
      "The Gift of the Magi",
      "THE FULL PROJECT GUTENBERG™ LICENSE",
    ]);
    expect(checkBook(b).ok).toBe(true);
  });
});

describe("zip limits", () => {
  it("refuses a file over the size limit and a zip bomb entry", async () => {
    expect(
      (await openEpub(new Uint8Array(EPUB_LIMITS.maxFileBytes + 1)).catch((e) => e)).code,
    ).toBe("too-large");
    const zip = new JSZip();
    zip.file("META-INF/container.xml", CONTAINER);
    zip.file(
      "OEBPS/content.opf",
      "<package>" + " ".repeat(EPUB_LIMITS.maxEntryBytes + 10) + "</package>",
    );
    const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(data.length).toBeLessThan(200_000);
    const err = await importEpub(data).catch((e) => e);
    expect(err.code).toBe("too-large");
  });
  it("not a zip", async () => {
    expect((await openEpub(new TextEncoder().encode("hello")).catch((e) => e)).code).toBe(
      "not-epub",
    );
  });
});

describe("checkBook (server-side validation)", () => {
  it("normalises, caps and checks chapters", () => {
    const r = checkBook({
      title: " T ",
      lines: ["Café"],
      chapters: [{ title: "A", start: 0 }],
      headings: [0, 9],
    });
    expect(r.ok && r.book).toEqual({
      title: "T",
      author: undefined,
      lang: undefined,
      lines: ["Café"],
      chapters: [{ title: "A", start: 0 }],
      headings: [0],
    });
    expect(checkBook({ title: "T", lines: ["a"], chapters: [{ title: "A", start: 3 }] }).ok).toBe(
      false,
    );
    expect(checkBook({ title: "T", lines: [] }).ok).toBe(false);
    expect(checkBook({ title: "T", lines: [1] }).ok).toBe(false);
    const big = Array.from({ length: 400 }, () => "x".repeat(BOOK_LIMITS.maxLineChars));
    expect(checkBook({ title: "T", lines: big })).toEqual({ ok: false, error: "too-much-text" });
  });
  it("round-trips the stored meta", () => {
    const r = checkBook({
      title: "T",
      author: "A",
      lines: ["a", "b"],
      chapters: [
        { title: "x", start: 0 },
        { title: "y", start: 1 },
      ],
    });
    if (!r.ok) throw new Error("bad");
    const meta = parseBookMeta(JSON.stringify(bookMetaOf(r.book)));
    expect(meta?.chapters).toEqual([
      { title: "x", start: 0 },
      { title: "y", start: 1 },
    ]);
    expect(meta?.author).toBe("A");
    expect(parseBookMeta("plain text")).toBeNull();
  });
});

describe("chapterAt", () => {
  it("finds the chapter that holds a line", () => {
    const ch = [
      { title: "a", start: 0 },
      { title: "b", start: 5 },
      { title: "c", start: 9 },
    ];
    expect([0, 4, 5, 8, 9, 100].map((l) => chapterAt(ch, l))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});
