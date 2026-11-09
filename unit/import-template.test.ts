import { describe, expect, it } from "bun:test";
import config from "@/intlayer.config";
import {
  TEMPLATES,
  TEMPLATE_FILE,
  templateCsv,
  templateFor,
  templateRows,
  templateXlsx,
} from "@/lib/import/template";
import { readXlsx, rowsToCsv } from "@/lib/import/xlsx";
import { HEADER_ALIASES, headerKey, parseWordList } from "@/lib/import/wordlist";

// docs/import-material.md, "Templates": the downloaded file already has the
// right header row in the user's language; the parser must read exactly it.

const LOCALES = config.internationalization!.locales as string[];

describe("word-list templates", () => {
  it("has one for every UI locale", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...LOCALES].sort());
  });

  it("names its columns with words the parser lists as aliases", () => {
    const keys = (role: keyof typeof HEADER_ALIASES) =>
      new Set(HEADER_ALIASES[role].map(headerKey));
    for (const [loc, t] of Object.entries(TEMPLATES)) {
      expect([loc, keys("term").has(headerKey(t.header[0]))]).toEqual([loc, true]);
      expect([loc, keys("back").has(headerKey(t.header[1]))]).toEqual([loc, true]);
      expect([loc, keys("ex").has(headerKey(t.header[2]))]).toEqual([loc, true]);
    }
  });

  it("falls back to English and reads regional tags", () => {
    expect(templateFor("zh-CN")).toBe(TEMPLATES.zh);
    expect(templateFor("pt_BR")).toBe(TEMPLATES.pt);
    expect(templateFor("xx")).toBe(TEMPLATES.en);
    expect(TEMPLATE_FILE).toMatch(/^[a-z-]+$/);
  });

  const expected = (loc: string) =>
    templateRows(loc)
      .slice(1)
      .map(([term, back, ex]) => ({ term, back, ex }));
  const parsed = (text: string) =>
    parseWordList(text, "template.csv").rows.map(({ term, back, ex }) => ({ term, back, ex }));

  for (const loc of LOCALES) {
    it(`${loc}: CSV template → parse → its example rows, header read`, () => {
      const csv = templateCsv(loc);
      expect(csv.startsWith("﻿")).toBe(true);
      expect(csv.endsWith("\r\n")).toBe(true);
      const p = parseWordList(csv, "template.csv");
      expect(p.header).toBe(true);
      expect(p.columns.term).toBe(0);
      expect(p.columns.back).toBe(1);
      expect(p.columns.ex).toBe(2);
      expect(parsed(csv)).toEqual(expected(loc));
    });

    it(`${loc}: XLSX template → read → parse → its example rows`, async () => {
      const rows = await readXlsx(await templateXlsx(loc));
      expect(rows).toEqual(templateRows(loc));
      const p = parseWordList(rowsToCsv(rows), "template.xlsx");
      expect(p.header).toBe(true);
      expect(parsed(rowsToCsv(rows))).toEqual(expected(loc));
    });
  }
});
