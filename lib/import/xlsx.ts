/**
 * A minimal .xlsx reader and writer for word lists (docs/import-material.md,
 * "CSV / Excel"). Only what a word table needs: the first sheet's cell text
 * in, a one-sheet workbook of text cells out.
 *
 * Built on jszip (already a dependency, MIT; loaded only when an .xlsx is
 * picked or a template downloaded), not SheetJS: the npm `xlsx` package is
 * frozen at a release with known advisories, and its maintained builds live
 * off npm. An .xlsx is a zip of XML parts; the few parts read here are
 * plain enough for a small scanner, so it runs the same in the browser and
 * in bun's unit tests (no DOMParser).
 *
 * Limits as the EPUB import: the file, each part and all decompressed bytes
 * are capped (zip bombs), and nothing is written anywhere — parts are looked
 * up by name. The old binary .xls (BIFF in an OLE container) is recognised
 * and refused with its own code, so the page can say "save it as .xlsx".
 */

export const XLSX_LIMITS = {
  /** The picked file. */
  maxFileBytes: 5 * 1024 * 1024,
  /** One decompressed part (a sheet, the shared strings). */
  maxPartBytes: 32 * 1024 * 1024,
  /** Everything decompressed for one workbook. */
  maxTotalBytes: 48 * 1024 * 1024,
  /** Rows read from the sheet (a word list fits far below). */
  maxRows: 25_000,
  /** Columns kept per row: a word table uses a few. */
  maxCols: 26,
};

export class XlsxError extends Error {
  constructor(
    readonly code: "not-xlsx" | "xls" | "too-large" | "empty",
    message: string = code,
  ) {
    super(message);
  }
}

type StreamHelper = {
  on(ev: "data", cb: (chunk: Uint8Array) => void): StreamHelper;
  on(ev: "end", cb: () => void): StreamHelper;
  on(ev: "error", cb: (e: Error) => void): StreamHelper;
  resume(): StreamHelper;
  pause(): StreamHelper;
};
type ZipEntry = { name: string; dir: boolean; internalStream(t: "uint8array"): StreamHelper };

/** The OLE compound-file signature: a legacy .xls (or .doc). */
export const isLegacyXls = (b: Uint8Array) =>
  b.length >= 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((v, i) => b[i] === v);

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML text → string: entities, numeric references, and OOXML's `_xHHHH_` escapes. */
export function xmlText(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`))?.[1] ??
  tag.match(new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`))?.[1];

/** The text of a string item (`<si>` or `<is>`): its `<t>` runs, phonetic guides (`<rPh>`) left out. */
function itemText(xml: string): string {
  const body = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g))
    out += xmlText(m[1] ?? "");
  return out;
}

/** sharedStrings.xml → the strings by index. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g))
    out.push(itemText(m[1] ?? ""));
  return out;
}

/** "B12" → column 1 (0-based); null when the reference has no letters. */
export function colIndex(ref: string): number | null {
  const letters = ref.match(/^[A-Z]+/i)?.[0];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * A worksheet's XML → rows of cell text. Cells land in their own column
 * (`r="C3"`), so a gap stays a gap; rows without any text are dropped;
 * trailing empty cells are trimmed. Numbers and booleans keep their stored
 * text, formulas their cached value.
 */
export function parseSheet(xml: string, shared: readonly string[]): string[][] {
  const rows: string[][] = [];
  const data = xml.match(/<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/)?.[1] ?? "";
  for (const r of data.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    if (rows.length >= XLSX_LIMITS.maxRows) break;
    const cells: string[] = [];
    let next = 0;
    for (const c of (r[1] ?? "").matchAll(
      /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g,
    )) {
      const tag = ` ${c[1]}`;
      const ref = attr(tag, "r");
      const col = (ref ? colIndex(ref) : null) ?? next;
      next = col + 1;
      if (col >= XLSX_LIMITS.maxCols) continue;
      const inner = c[2] ?? "";
      const type = attr(tag, "t");
      const v = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
      let text = "";
      if (type === "inlineStr") {
        const is = inner.match(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/)?.[1];
        text = is ? itemText(is) : "";
      } else if (type === "s") text = shared[Number(v)] ?? "";
      else if (type === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else if (v !== undefined) text = xmlText(v);
      while (cells.length < col) cells.push("");
      cells[col] = text;
    }
    while (cells.length && !cells[cells.length - 1].trim()) cells.pop();
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** The first sheet's part, from workbook.xml and its relationships; null when they do not say. */
export function firstSheetPath(workbook: string, rels: string): string | null {
  const sheet = workbook.match(/<(?:\w+:)?sheet\b[^>]*>/)?.[0];
  if (!sheet) return null;
  const id = sheet.match(/\s(?:\w+:)?id\s*=\s*"([^"]*)"/)?.[1];
  if (!id) return null;
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    if (attr(` ${m[0].slice(1)}`, "Id") !== id) continue;
    const target = attr(` ${m[0].slice(1)}`, "Target");
    if (!target) return null;
    // Relative to xl/, or absolute from the package root.
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    // "xl/./worksheets/../worksheets/sheet1.xml" → "xl/worksheets/sheet1.xml"
    const parts: string[] = [];
    for (const p of path.split("/")) {
      if (p === "..") parts.pop();
      else if (p && p !== ".") parts.push(p);
    }
    return parts.join("/");
  }
  return null;
}

/**
 * .xlsx bytes → the first sheet's rows of text. Throws `XlsxError`: `xls`
 * for a legacy binary workbook, `not-xlsx` for anything else that is not
 * one, `too-large` past the limits, `empty` for a sheet with no text.
 */
export async function readXlsx(data: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > XLSX_LIMITS.maxFileBytes) throw new XlsxError("too-large");
  if (isLegacyXls(bytes)) throw new XlsxError("xls");
  const { default: JSZip } = await import("jszip");
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  } catch {
    throw new XlsxError("not-xlsx", "not a zip file");
  }
  const byName = new Map(
    (Object.values(zip.files) as unknown as ZipEntry[]).map((f) => [f.name, f]),
  );
  let total = 0;
  const read = (path: string) =>
    new Promise<string | null>((resolve, reject) => {
      const f = byName.get(path);
      if (!f || f.dir) return resolve(null);
      const chunks: Uint8Array[] = [];
      let n = 0;
      let done = false;
      const stream = f.internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          if (done) return;
          n += chunk.length;
          total += chunk.length;
          if (n > XLSX_LIMITS.maxPartBytes || total > XLSX_LIMITS.maxTotalBytes) {
            done = true;
            stream.pause();
            reject(new XlsxError("too-large", "decompressed size limit"));
            return;
          }
          chunks.push(chunk);
        })
        .on("error", (e) => {
          if (done) return;
          done = true;
          reject(new XlsxError("not-xlsx", e.message));
        })
        .on("end", () => {
          if (done) return;
          done = true;
          const all = new Uint8Array(n);
          let o = 0;
          for (const c of chunks) {
            all.set(c, o);
            o += c.length;
          }
          resolve(new TextDecoder("utf-8").decode(all));
        })
        .resume();
    });

  const workbook = await read("xl/workbook.xml");
  if (workbook === null) throw new XlsxError("not-xlsx", "no workbook part");
  const rels = (await read("xl/_rels/workbook.xml.rels")) ?? "";
  const fallback = [...byName.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  const path = firstSheetPath(workbook, rels) ?? fallback;
  const sheet = path ? await read(path) : null;
  if (sheet === null) throw new XlsxError("not-xlsx", "no worksheet");
  const shared = parseSharedStrings((await read("xl/sharedStrings.xml")) ?? "");
  const rows = parseSheet(sheet, shared);
  if (!rows.length) throw new XlsxError("empty");
  return rows;
}

/** One CSV field: quoted when it holds a comma, a quote or a line break. */
const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Rows → RFC 4180 CSV (CRLF). Every row is padded to the widest one, and to
 * at least two columns, so the word-list parser always sees a table (a
 * one-column sheet's header row is then read as a header, not as a word).
 */
export function rowsToCsv(rows: readonly (readonly string[])[]): string {
  const width = Math.max(2, ...rows.map((r) => r.length));
  return rows
    .map((r) => Array.from({ length: width }, (_, i) => csvField(r[i] ?? "")).join(","))
    .join("\r\n");
}

const XML_ESC: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" };
/** Control characters XML 1.0 cannot carry (tab, line feed and carriage return can). */
const XML_BAD = (c: string) => {
  const n = c.charCodeAt(0);
  return n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d;
};
const esc = (s: string) =>
  [...s.replace(/[<>&"]/g, (c) => XML_ESC[c])].filter((c) => !XML_BAD(c)).join("");

/** 0 → "A", 27 → "AB". */
export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * Rows of text → a one-sheet .xlsx (inline strings, so no shared-strings
 * part), the first row bold as a header and frozen, columns wide enough to
 * type in. Opens in Excel, Numbers, LibreOffice and Google Sheets.
 */
export async function writeXlsx(
  rows: readonly (readonly string[])[],
  sheetName = "Words",
): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const width = Math.max(1, ...rows.map((r) => r.length));
  const cols = Array.from(
    { length: width },
    (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 22 : 40}" customWidth="1"/>`,
  ).join("");
  const body = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r
          .map(
            (v, ci) =>
              `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const ns = "http://schemas.openxmlformats.org";
  zip.file(
    "[Content_Types].xml",
    `${decl}<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${decl}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `${decl}<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `${decl}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `${decl}<styleSheet xmlns="${ns}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `${decl}<worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
