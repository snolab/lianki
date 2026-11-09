import { describe, expect, it } from "bun:test";
import JSZip from "jszip";
import {
  XLSX_LIMITS,
  XlsxError,
  colIndex,
  colName,
  firstSheetPath,
  isLegacyXls,
  parseSharedStrings,
  parseSheet,
  readXlsx,
  rowsToCsv,
  writeXlsx,
  xmlText,
} from "@/lib/import/xlsx";
import { parseWordList } from "@/lib/import/wordlist";

// docs/import-material.md, "CSV / Excel": the first sheet of an .xlsx → rows.

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

/** A workbook as Excel writes one: shared strings, a relationship to the sheet. */
async function excelLike(opts: {
  sheet: string;
  shared?: string;
  target?: string;
  sheetsBefore?: boolean;
  noRels?: boolean;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  const target = opts.target ?? "worksheets/sheet1.xml";
  zip.file(
    "xl/workbook.xml",
    `<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Words" sheetId="7" r:id="rId3"/><sheet name="Other" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  if (!opts.noRels)
    zip.file(
      "xl/_rels/workbook.xml.rels",
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Target="${target}"/></Relationships>`,
    );
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  zip.file(
    path.replace("/./", "/"),
    `<worksheet ${NS}><sheetData>${opts.sheet}</sheetData></worksheet>`,
  );
  if (path !== "xl/worksheets/sheet1.xml")
    zip.file(
      "xl/worksheets/sheet1.xml",
      `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>`,
    );
  if (opts.shared) zip.file("xl/sharedStrings.xml", `<sst ${NS}>${opts.shared}</sst>`);
  return zip.generateAsync({ type: "uint8array" });
}

describe("xmlText", () => {
  it("decodes entities, numeric references and _xHHHH_ escapes", () => {
    expect(xmlText("a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;")).toBe(`a <b> & "c" 'd'`);
    expect(xmlText("&#26085;&#x672C;&#x1F600;")).toBe("日本😀");
    expect(xmlText("line_x000D_end")).toBe("line\rend");
    expect(xmlText("&unknown; &#0;")).toBe("&unknown; ");
  });
});

describe("cells and columns", () => {
  it("maps column letters both ways", () => {
    expect(colIndex("A1")).toBe(0);
    expect(colIndex("c7")).toBe(2);
    expect(colIndex("AB12")).toBe(27);
    expect(colIndex("12")).toBeNull();
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("reads shared strings, rich-text runs, and leaves phonetic guides out", () => {
    const s = parseSharedStrings(
      `<si><t>apple</t></si><si><r><rPr><b/></rPr><t>li</t></r><r><t xml:space="preserve">brary</t></r></si><si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></si><si/><si><t/></si>`,
    );
    expect(s).toEqual(["apple", "library", "漢字", "", ""]);
  });

  it("puts each cell in its own column, keeps gaps, drops empty rows", () => {
    const rows = parseSheet(
      `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>ex &amp; more</t></is></c></row>
        <row r="2"/>
        <row r="3"><c r="A3"><v>42</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" t="b"><v>0</v></c><c r="D3" t="str"><f>A3</f><v>42</v></c><c r="E3" t="b"><v>x</v></c></row>
        <row r="4"><c r="A4" t="s"/><c r="B4"><v> </v></c></row>
        <row><c t="inlineStr"><is><t>no ref</t></is></c><c t="inlineStr"><is><t>next</t></is></c></row>
      </sheetData></worksheet>`,
      ["word"],
    );
    expect(rows).toEqual([
      ["word", "", "ex & more"],
      ["42", "TRUE", "FALSE", "42"],
      ["no ref", "next"],
    ]);
  });

  it("reads namespaced parts (x:row, x:c) as written by some generators", () => {
    const rows = parseSheet(
      `<x:worksheet><x:sheetData><x:row><x:c r="A1" t="inlineStr"><x:is><x:t>hola</x:t></x:is></x:c><x:c r="B1" t="s"><x:v>0</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
      ["hello"],
    );
    expect(rows).toEqual([["hola", "hello"]]);
  });

  it("keeps only the first columns and rows up to the limits", () => {
    const far = parseSheet(
      `<sheetData><row><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="AA1" t="inlineStr"><is><t>far</t></is></c></row></sheetData>`,
      [],
    );
    expect(far).toEqual([["a"]]);
    const many = Array.from(
      { length: XLSX_LIMITS.maxRows + 5 },
      (_, i) => `<row><c r="A${i + 1}"><v>${i}</v></c></row>`,
    ).join("");
    expect(parseSheet(`<sheetData>${many}</sheetData>`, []).length).toBe(XLSX_LIMITS.maxRows);
    expect(parseSheet("<worksheet/>", [])).toEqual([]);
  });

  it("finds the first sheet through the workbook's relationships", () => {
    const wb = `<sheets><sheet name="A" sheetId="2" r:id="rId9"/></sheets>`;
    expect(
      firstSheetPath(
        wb,
        `<Relationships><Relationship Id="rId9" Target="worksheets/a.xml"/></Relationships>`,
      ),
    ).toBe("xl/worksheets/a.xml");
    expect(
      firstSheetPath(
        wb,
        `<Relationships><Relationship Id="rId9" Target="/xl/./x/../b.xml"/></Relationships>`,
      ),
    ).toBe("xl/b.xml");
    expect(
      firstSheetPath(wb, `<Relationships><Relationship Id="rId9"/></Relationships>`),
    ).toBeNull();
    expect(firstSheetPath(wb, "")).toBeNull();
    expect(firstSheetPath(`<sheets><sheet name="A"/></sheets>`, "")).toBeNull();
    expect(firstSheetPath("<workbook/>", "")).toBeNull();
  });
});

describe("readXlsx", () => {
  it("reads the workbook's first sheet, not sheet1.xml by name", async () => {
    const bytes = await excelLike({
      target: "worksheets/sheet2.xml",
      shared: "<si><t>Word</t></si><si><t>Meaning</t></si><si><t>gato</t></si><si><t>cat</t></si>",
      sheet: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>`,
    });
    expect(await readXlsx(bytes)).toEqual([
      ["Word", "Meaning"],
      ["gato", "cat"],
    ]);
    // An ArrayBuffer works as well.
    expect((await readXlsx(bytes.slice().buffer)).length).toBe(2);
  });

  it("falls back to the lowest-numbered sheet part without relationships", async () => {
    const bytes = await excelLike({
      noRels: true,
      sheet: `<row><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row>`,
    });
    expect(await readXlsx(bytes)).toEqual([["wrong sheet"]]);
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof XlsxError ? e.code : String(e);
    }
  };

  it("refuses a legacy .xls, a non-zip, a zip without a workbook, an empty sheet, a huge file", async () => {
    const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(isLegacyXls(xls)).toBe(true);
    expect(isLegacyXls(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(await code(readXlsx(xls))).toBe("xls");
    expect(await code(readXlsx(new TextEncoder().encode("word,meaning\n")))).toBe("not-xlsx");
    const noBook = new JSZip();
    noBook.file("hello.txt", "hi");
    expect(await code(readXlsx(await noBook.generateAsync({ type: "uint8array" })))).toBe(
      "not-xlsx",
    );
    const noSheet = new JSZip();
    noSheet.file("xl/workbook.xml", "<workbook/>");
    expect(await code(readXlsx(await noSheet.generateAsync({ type: "uint8array" })))).toBe(
      "not-xlsx",
    );
    expect(await code(readXlsx(await excelLike({ sheet: "<row/>" })))).toBe("empty");
    expect(await code(readXlsx(new Uint8Array(XLSX_LIMITS.maxFileBytes + 1)))).toBe("too-large");
  });

  it("stops a zip bomb at the decompressed limit", async () => {
    const zip = new JSZip();
    zip.file("xl/workbook.xml", "<workbook/>");
    zip.file("xl/worksheets/sheet1.xml", "a".repeat(XLSX_LIMITS.maxPartBytes + 10));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bytes.byteLength).toBeLessThan(XLSX_LIMITS.maxFileBytes);
    expect(await code(readXlsx(bytes))).toBe("too-large");
  });
});

describe("rowsToCsv and writeXlsx", () => {
  it("quotes only what needs it and pads rows to the widest (at least two)", () => {
    expect(rowsToCsv([["a"], ["b, c", 'say "hi"', "x\ny"]])).toBe(
      'a,,\r\n"b, c","say ""hi""","x\ny"',
    );
    expect(rowsToCsv([["单词"], ["猫"]])).toBe("单词,\r\n猫,");
  });

  it("a one-column sheet's header is read as a header, not as a word", () => {
    const p = parseWordList(rowsToCsv([["单词"], ["猫"], ["狗"]]));
    expect(p.header).toBe(true);
    expect(p.rows.map((r) => r.term)).toEqual(["猫", "狗"]);
  });

  it("round-trips text through a written workbook: XML characters, scripts, gaps", async () => {
    const rows = [
      ["Word", "Meaning", "Example"],
      ["<b>&amp;", 'quote " here', "tab\there"],
      ["日本語", "", "مرحبا"],
    ];
    const bytes = await writeXlsx(rows, "A very long sheet name that Excel would refuse");
    const back = await readXlsx(bytes);
    expect(back).toEqual(rows);
    const zip = await JSZip.loadAsync(bytes);
    const wb = await zip.file("xl/workbook.xml")!.async("string");
    expect(wb).toContain('name="A very long sheet name that Exc"');
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('s="1"');
  });

  it("drops control characters XML cannot carry", async () => {
    expect(await readXlsx(await writeXlsx([["a\u0001b", "c"]]))).toEqual([["ab", "c"]]);
  });
});
