// Inline emphasis and in-paragraph line breaks kept from the EPUB (#448
// dropped them), beside plain lines that stay exactly as before.
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { extractMarks, parseEpub, type EpubArchive } from "@/lib/epub/parse";
import { bookMetaOf, checkBook, checkMarkup, parseBookMeta } from "@/lib/read/book";
import { bookHash, paragraphsOf } from "@/lib/read/units";
import { useBackend, useD1 } from "./support/testMocks";

const { findReadMaterialByText, saveReadMaterial } =
  await import("@/lib/getReadMaterialsCollection");

const CONTAINER = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
const mem = (files: Record<string, string>): EpubArchive => ({
  list: () => Object.keys(files),
  read: async (p) => files[p] ?? null,
});
const book = (body: string) =>
  mem({
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:language>fr</dc:language></metadata>
      <manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="a"/></spine></package>`,
    "OEBPS/a.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`,
  });

describe("extractMarks", () => {
  const O = (k: number) => String.fromCharCode(0xfdd0 + k);
  const C = (k: number) => String.fromCharCode(0xfde0 + k);

  it("plain text exactly as before, marks as ranges into it", () => {
    const r = extractMarks(`  Il ${O(0)} était ${C(0)}  une ${O(1)}fois${C(1)}.\n`);
    expect(r.text).toBe("Il était une fois.");
    expect(r.marks).toEqual([
      [3, 8, "em"],
      [13, 17, "strong"],
    ]);
  });

  it("empty and unclosed marks; a leading no-break space trimmed as before", () => {
    expect(extractMarks(`a${O(0)}${C(0)}b`).marks).toEqual([]);
    expect(extractMarks(` ${O(2)}x y`)).toEqual({ text: "x y", marks: [[0, 3, "sup"]] });
  });

  it("NFC shifts offsets with the text", () => {
    const r = extractMarks(`été ${O(0)}chaud${C(0)}`);
    expect(r.text).toBe("été chaud");
    expect(r.marks).toEqual([[4, 9, "em"]]);
  });
});

describe("parseEpub keeps markup beside the lines", () => {
  it("emphasis, sup, and <br> as a break inside the paragraph", async () => {
    const b = await parseEpub(
      book(
        `<p>Il <i>était</i> une <b>fois</b>.<br/>Deuxième <em>ligne</em>.</p><p><br/>Seul<sup>1</sup>.</p>`,
      ),
    );
    expect(b.lines).toEqual(["Il était une fois.", "Deuxième ligne.", "Seul1."]);
    expect(b.marks).toEqual([
      [0, 3, 8, "em"],
      [0, 13, 17, "strong"],
      [1, 9, 14, "em"],
      [2, 4, 5, "sup"],
    ]);
    // Line 1 continues paragraph 0; a <br> at the start of a block joins nothing.
    expect(b.breaks).toEqual([1]);
    expect(paragraphsOf(b.lines.length, b)).toEqual([
      { start: 0, end: 2, breaks: [1] },
      { start: 2, end: 3, breaks: [] },
    ]);
  });

  it("a long paragraph split at import: its parts continue it, marks follow them", async () => {
    const s = "Une phrase assez longue pour remplir. ".repeat(250);
    const b = await parseEpub(book(`<p><i>Début</i> ${s}<b>fin</b>.</p>`));
    expect(b.lines.length).toBeGreaterThan(1);
    expect(b.continues).toEqual(b.lines.slice(1).map((_, i) => i + 1));
    expect(b.marks?.[0]).toEqual([0, 0, 5, "em"]);
    const last = b.marks![b.marks!.length - 1];
    expect(last[0]).toBe(b.lines.length - 1);
    expect(b.lines[last[0]].slice(last[1], last[2])).toBe("fin");
  });
});

describe("the stored shape", () => {
  it("checkBook keeps sane markup, drops the rest; meta round-trips", () => {
    const c = checkBook({
      title: "T",
      lines: ["abc", "def"],
      marks: [
        [0, 0, 2, "em"],
        [0, 1, 9, "em"],
        [1, 0, 1, "script"],
        [5, 0, 1, "em"],
        [0, 2, 1, "em"],
        "x",
      ],
      breaks: [1, 0, 7],
      continues: [1],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.book.marks).toEqual([[0, 0, 2, "em"]]);
    expect(c.book.breaks).toEqual([1]);
    expect(c.book.continues).toEqual([]);
    const meta = bookMetaOf(c.book);
    expect(meta.markup).toBe(1);
    const back = parseBookMeta(JSON.stringify(meta));
    expect(back?.marks).toEqual([[0, 0, 2, "em"]]);
    expect(back?.breaks).toEqual([1]);
  });

  it("books from before have no markup and stay as they were", () => {
    const c = checkBook({ title: "T", lines: ["abc"] });
    expect(c.ok && bookMetaOf(c.book).markup).toBeUndefined();
    expect(checkMarkup({}, ["abc"])).toBeNull();
    expect(checkMarkup({ breaks: "x" }, null)).toBeNull();
    expect(checkMarkup({ breaks: [0, 2, 2] }, null)).toEqual({
      marks: [],
      breaks: [2],
      continues: [],
    });
  });
});

describe("the same EPUB imported again finds the book it upgrades", () => {
  let d1: TestD1Database;
  beforeEach(() => {
    d1 = createTestD1(testSchema());
    useD1(d1);
    useBackend("d1");
  });

  it("by stored hash, or by identical lines for a book without one; only the user's own", async () => {
    const lines = ["Il était une fois."];
    const hash = await bookHash(lines);
    const old = await saveReadMaterial("u1", "T", "{}", lines);
    expect(old.contentHash).toBeUndefined();
    expect(String((await findReadMaterialByText("u1", hash, lines))?._id)).toBe(String(old._id));
    expect(await findReadMaterialByText("u2", hash, lines)).toBeNull();
    expect(await findReadMaterialByText("u1", hash, ["Autre."])).toBeNull();
    const hashed = await saveReadMaterial("u2", "T", "{}", ["x"], "aaaaaaaaaaaaaaaa");
    expect(hashed.contentHash).toBe("aaaaaaaaaaaaaaaa");
    expect(String((await findReadMaterialByText("u2", "aaaaaaaaaaaaaaaa", ["y"]))?._id)).toBe(
      String(hashed._id),
    );
  });
});
