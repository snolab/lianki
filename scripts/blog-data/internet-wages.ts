/**
 * Builds the tables for the internet-jobs wage post from official statistics.
 *
 *   bun scripts/blog-data/internet-wages.ts
 *
 * Input:  blog/data/internet-wages/*.csv — one file per source, every value as
 *         the agency published it (see SOURCES.md there for tables and URLs).
 * Output: markdown tables on stdout, for
 *         blog/en/2026-10-21-internet-jobs-pay-by-city.md.
 *
 * Every figure is turned into gross annual pay in purchasing-power dollars:
 * monthly × 12, weekly × 52, then divided by the World Bank private-consumption
 * PPP factor (PA.NUS.PRVT.PP) for the data's own year. Nothing else is
 * adjusted — no inflation to a common year, no net-to-gross conversion — and
 * means are never put in a median column.
 */
import { readFileSync } from "fs";
import { join } from "path";

const DIR = join(import.meta.dir, "../../blog/data/internet-wages");

/** World Bank PA.NUS.PRVT.PP, local currency per international dollar (data updated 2026-10-08). */
const PPP: Record<string, Record<number, number>> = {
  "United States": { 2025: 1 },
  Canada: { 2020: 1.2864 },
  "United Kingdom": { 2025: 0.7015 },
  Germany: { 2025: 0.7189 },
  Japan: { 2025: 103.3366 },
  Australia: { 2025: 1.4646 },
  Spain: { 2022: 0.6225, 2024: 0.5885 },
  Switzerland: { 2024: 1.1072 },
  Luxembourg: { 2022: 0.8937 },
  Belgium: { 2022: 0.779 },
};

type Row = Record<string, string>;

/** RFC 4180 CSV: quoted fields may contain commas, quotes and newlines. */
function readCsv(file: string): Row[] {
  const text = readFileSync(join(DIR, file), "utf-8");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (record.push(field), (field = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      (record.push(field), records.push(record), (record = []), (field = ""));
    } else field += ch;
  }
  if (field || record.length) (record.push(field), records.push(record));
  const [header, ...rows] = records.filter((r) => r.some((f) => f !== ""));
  return rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ""])));
}

const data = {
  us: readCsv("us.csv"),
  ca: readCsv("ca.csv"),
  uk: readCsv("uk.csv"),
  de: readCsv("de.csv"),
  jp: readCsv("jp.csv"),
  au: readCsv("au.csv"),
  es: readCsv("es.csv"),
  so: readCsv("so_survey.csv"),
  frz: readCsv("fr_zone.csv"),
};

const PCT = ["p10", "p25", "median", "p75", "p90"] as const;
type Pct = (typeof PCT)[number];

/** Gross annual pay in PPP dollars, or undefined when the cell is empty. */
function annualPpp(row: Row, key: Pct): number | undefined {
  if (!row[key]) return undefined;
  const year = Number(row.year!.slice(0, 4));
  const factor = PPP[row.country!]?.[year];
  if (!factor) throw new Error(`no PPP factor for ${row.country} ${year}`);
  const m = row.measure!.toLowerCase();
  const perYear = m.includes("weekly") ? 52 : m.includes("monthly") ? 12 : 1;
  return (Number(row[key]) * perYear) / factor;
}

function one(rows: Row[], pred: (r: Row) => boolean, what: string): Row {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`${what}: expected 1 row, got ${hits.length}`);
  return hits[0]!;
}
const has = (r: Row, s: string) => r.measure!.includes(s);
const k = (n: number | undefined) => (n === undefined ? "—" : `$${Math.round(n / 1000)}k`);

// ---------------------------------------------------------------------------
// 1. Software / IT pay by city: published medians
// ---------------------------------------------------------------------------

type CityRow = {
  place: string;
  country: string;
  basis: string;
  median: number;
  p10?: number;
  p90?: number;
};
const cityRows: CityRow[] = [];

for (const r of data.us.filter((r) => has(r, "(15-1252)") && r.area_definition !== "national"))
  cityRows.push({
    place: r.city!,
    country: "United States",
    basis: "Software developers, 2025",
    median: annualPpp(r, "median")!,
    p10: annualPpp(r, "p10"),
    p90: annualPpp(r, "p90"),
  });
for (const r of data.ca.filter((r) => has(r, "minor group 2123")))
  cityRows.push({
    place: r.city!,
    country: "Canada",
    basis: "Software & web developers, 2020",
    median: annualPpp(r, "median")!,
  });
const DE_NAME: Record<string, string> = {
  München: "Munich",
  Köln: "Cologne",
  "Frankfurt am Main": "Frankfurt",
};
for (const r of data.de.filter((r) => has(r, "Berufshauptgruppe 43")))
  cityRows.push({
    place: DE_NAME[r.city!] ?? r.city!,
    country: "Germany",
    basis: "IT occupations, 2025",
    median: annualPpp(r, "median")!,
  });
// UK occupation figures are by region; list each region once, named by its cities.
const ukRegions = new Map<string, { cities: string[]; row: Row }>();
for (const r of data.uk.filter((r) => has(r, "SOC 2020 2134 ") && r.median)) {
  const region = /^(.*?)(?: region| \()/.exec(r.area_definition!)![1]!;
  const entry = ukRegions.get(region) ?? { cities: [], row: r };
  entry.cities.push(r.city!);
  ukRegions.set(region, entry);
}
for (const [region, { cities, row }] of ukRegions)
  cityRows.push({
    place: region === "London" ? "London" : `${region} (${cities.join(", ")})`,
    country: "United Kingdom",
    basis: "Software developers, 2025, by region",
    median: annualPpp(row, "median")!,
  });

cityRows.sort((a, b) => b.median - a.median);
console.log("## Software and IT pay by city (median, gross, PPP $/year)\n");
console.log(
  "| # | City | Country | Median | P10 | P90 | Basis |\n| ---: | --- | --- | ---: | ---: | ---: | --- |",
);
cityRows.forEach((c, i) =>
  console.log(
    `| ${i + 1} | ${c.place} | ${c.country} | ${k(c.median)} | ${k(c.p10)} | ${k(c.p90)} | ${c.basis} |`,
  ),
);

// ---------------------------------------------------------------------------
// 2. The spread: P10–P90 for software/IT, where an agency publishes it
// ---------------------------------------------------------------------------

const spread: { label: string; row: Row; note: string }[] = [
  {
    label: "United States (national)",
    row: one(data.us, (r) => r.area_definition === "national" && has(r, "(15-1252)"), "us nat"),
    note: "Software developers, 2025",
  },
  {
    label: "San Francisco",
    row: one(data.us, (r) => r.city === "San Francisco" && has(r, "(15-1252)"), "sf"),
    note: "Software developers, 2025",
  },
  {
    label: "London",
    row: one(data.uk, (r) => r.city === "London" && has(r, "SOC 2020 213 "), "london 213"),
    note: "IT professionals (SOC 213), 2025",
  },
  {
    label: "Japan (national)",
    row: one(
      data.jp,
      (r) => r.area_definition === "national" && has(r, "ソフトウェア作成者"),
      "jp",
    ),
    note: "Software developers, 2025 — monthly pay × 12, bonus not included",
  },
  {
    label: "Australia (national)",
    row: one(
      data.au,
      (r) => r.area_definition === "National" && has(r, "sub-major group 26"),
      "au",
    ),
    note: "ICT professionals, 2025 — includes part-time",
  },
  {
    label: "Spain (national)",
    row: one(data.es, (r) => r.area_definition === "National" && has(r, "subgroup 27"), "es"),
    note: "IT professionals, 2022 — includes part-time",
  },
];
console.log("\n## Spread for software and IT jobs (gross, PPP $/year)\n");
console.log(
  "| Where | P10 | P25 | Median | P75 | P90 | P90 ÷ P10 | What is measured |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
);
for (const s of spread) {
  const v = PCT.map((p) => annualPpp(s.row, p));
  const ratio = v[0] && v[4] ? (v[4] / v[0]).toFixed(1) : "—";
  console.log(`| ${s.label} | ${v.map(k).join(" | ")} | ${ratio} | ${s.note} |`);
}

// ---------------------------------------------------------------------------
// 3. Bilingual cities against their neighbours, same source and year
// ---------------------------------------------------------------------------

const caMedian = (city: string, match: string) =>
  annualPpp(
    one(
      data.ca,
      (r) => r.city === city && (match ? has(r, match) : !has(r, " - ")),
      `${city} ${match}`,
    ),
    "median",
  );
console.log(
  "\n## Bilingual Montreal and Ottawa–Gatineau vs Toronto and Vancouver (median, PPP $/year, 2020)\n",
);
console.log(
  "| City | Languages | All full-time workers | Software & web developers | Information and cultural industries |\n| --- | --- | ---: | ---: | ---: |",
);
for (const [city, langs] of [
  ["Toronto", "English"],
  ["Vancouver", "English"],
  ["Ottawa–Gatineau", "English, French"],
  ["Montréal", "French, English"],
  ["Québec", "French"],
] as const)
  console.log(
    `| ${city} | ${langs} | ${k(caMedian(city, ""))} | ${k(caMedian(city, "minor group 2123"))} | ${k(caMedian(city, "sector 51 Information"))} |`,
  );

console.log("\n## Barcelona (Catalonia) vs Madrid, all employees, 2024 (gross, PPP $/year)\n");
console.log(
  "| Region | Languages | P10 | P25 | Median | P75 | P90 |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |",
);
for (const [area, langs] of [
  ["Comunidad de Madrid", "Spanish"],
  ["Cataluña", "Spanish, Catalan"],
  ["País Vasco", "Spanish, Basque"],
  ["Comunitat Valenciana", "Spanish, Catalan"],
] as const) {
  const r = one(data.es, (r) => r.area_definition!.endsWith(area) && r.year === "2024", area);
  console.log(`| ${area} | ${langs} | ${PCT.map((p) => k(annualPpp(r, p))).join(" | ")} |`);
}

// ---------------------------------------------------------------------------
// 4. Beyond developers: design, media, marketing (medians)
// ---------------------------------------------------------------------------

type Pick = (rows: Row[]) => Row | undefined;
const find =
  (pred: (r: Row) => boolean): Pick =>
  (rows) =>
    rows.find((r) => pred(r) && r.median);
const roleTable: {
  place: string;
  rows: Row[];
  dev: Pick;
  design: Pick;
  media: Pick;
  marketing: Pick;
  note: string;
}[] = [
  ...["New York", "San Francisco", "Seattle", "Austin"].map((city) => ({
    place: city,
    rows: data.us.filter((r) => r.city === city),
    dev: find((r) => has(r, "(15-1252)")),
    design: find((r) => has(r, "(15-1255)")),
    media: find((r) => has(r, "(27-3041)")),
    marketing: find((r) => has(r, "(13-1161)")),
    note: "2025; design = web & digital interface designers, media = editors, marketing = marketing specialists",
  })),
  {
    place: "London",
    rows: data.uk.filter((r) => r.city === "London"),
    dev: find((r) => has(r, "SOC 2020 2134 ")),
    design: find((r) => has(r, "SOC 2020 2142 ")),
    media: find((r) => has(r, "SOC 2020 249 ")),
    marketing: find((r) => has(r, "SOC 2020 3554 ")),
    note: "2025; graphic & multimedia designers, media professionals, marketing associate professionals",
  },
  ...["Toronto", "Montréal"].map((city) => ({
    place: city,
    rows: data.ca.filter((r) => r.city === city),
    dev: find((r) => has(r, "minor group 2123")),
    design: find((r) => has(r, "minor group 5212")),
    media: find((r) => has(r, "minor group 5111")),
    marketing: find((r) => has(r, "minor group 1120")),
    note: "2020; graphic & interior designers, writers/editors/translators, business professionals incl. marketing",
  })),
  ...["München", "Berlin"].map((city) => ({
    place: city === "München" ? "Munich" : city,
    rows: data.de.filter((r) => r.city === city),
    dev: find((r) => has(r, "Berufshauptgruppe 43")),
    design: () => undefined,
    media: find((r) => has(r, "Berufshauptgruppe 92")),
    marketing: find((r) => has(r, "Berufshauptgruppe 92")),
    note: "2025; IT occupations; advertising, marketing and media is one group (shown in both columns)",
  })),
  {
    place: "Japan (national)",
    rows: data.jp.filter((r) => r.area_definition === "national"),
    dev: find((r) => has(r, "ソフトウェア作成者")),
    design: find((r) => has(r, "デザイナー")),
    media: find((r) => has(r, "著述家")),
    marketing: () => undefined,
    note: "2025; monthly pay × 12, bonus not included",
  },
  {
    place: "Australia (national)",
    rows: data.au.filter((r) => r.area_definition === "National"),
    dev: find((r) => has(r, "sub-major group 26")),
    design: () => undefined,
    media: find((r) => has(r, "sub-major group 21")),
    marketing: find((r) => has(r, "sub-major group 22")),
    note: "2025; includes part-time; arts & media professionals; business, HR & marketing professionals",
  },
  {
    place: "Spain (national)",
    rows: data.es.filter((r) => r.area_definition === "National"),
    dev: find((r) => has(r, "subgroup 27")),
    design: () => undefined,
    media: find((r) => has(r, "subgroup 29")),
    marketing: find((r) => has(r, "subgroup 26")),
    note: "2022; includes part-time; culture & media professionals; sales, marketing & organisation specialists",
  },
];
console.log("\n## Developers, designers, media and marketing (median, gross, PPP $/year)\n");
console.log(
  "| Where | Software / IT | Design | Media & writing | Marketing | Notes |\n| --- | ---: | ---: | ---: | ---: | --- |",
);
for (const t of roleTable) {
  const cell = (p: Pick) => {
    const r = p(t.rows);
    return k(r && annualPpp(r, "median"));
  };
  console.log(
    `| ${t.place} | ${cell(t.dev)} | ${cell(t.design)} | ${cell(t.media)} | ${cell(t.marketing)} | ${t.note} |`,
  );
}

// ---------------------------------------------------------------------------
// 5. Stack Overflow survey: developers by country (exchange-rate USD)
// ---------------------------------------------------------------------------

const SO_LANG: Record<string, string> = {
  "United States": "English",
  Switzerland: "German, French, Italian",
  Israel: "Hebrew",
  Ireland: "English",
  Australia: "English",
  "United Kingdom": "English",
  Canada: "English, French",
  Germany: "German",
  Netherlands: "Dutch",
  Sweden: "Swedish",
  Austria: "German",
  Belgium: "Dutch, French",
  Spain: "Spanish",
  France: "French",
  Portugal: "Portuguese",
  Poland: "Polish",
  Italy: "Italian",
  "South Africa": "English",
  Mexico: "Spanish",
  Brazil: "Portuguese",
  Ukraine: "Ukrainian",
  Turkey: "Turkish",
  India: "Hindi, English",
};
console.log(
  "\n## Stack Overflow Developer Survey 2025: employed professional developers (USD at exchange rates)\n",
);
console.log(
  "| Country | Languages | Answers | P10 | Median | P90 |\n| --- | --- | ---: | ---: | ---: | ---: |",
);
for (const r of data.so.filter((r) => SO_LANG[r.country!]))
  console.log(
    `| ${r.country} | ${SO_LANG[r.country!]} | ${Number(r.n).toLocaleString("en-US")} | ${k(Number(r.p10))} | ${k(Number(r.median))} | ${k(Number(r.p90))} |`,
  );

// ---------------------------------------------------------------------------
// 6. Japan by prefecture: averages including bonus (no medians are published)
// ---------------------------------------------------------------------------

/**
 * Prefecture tables give only means: monthly scheduled pay (所定内給与額) and the
 * annual bonus (年間賞与その他特別給与額), both in thousands of yen. Their sum
 * ×12 + bonus is the mean annual pay without overtime. Kept apart from every
 * median table above.
 */
function jpMeanAnnualYen(row: Row): number {
  const m = /mean 所定内給与額 = ([\d.]+).*?mean 年間賞与その他特別給与額 = ([\d.]+)/.exec(
    row.notes!,
  );
  if (!m) throw new Error(`no means in notes for ${row.city} ${row.measure}`);
  return (Number(m[1]) * 12 + Number(m[2])) * 1000;
}
const JP_COLUMNS: [string, string][] = [
  ["All workers", "一般労働者)"],
  ["Information & communications industry", "情報通信業"],
  ["Software developers", "ソフトウェア作成者"],
  ["System consultants & designers", "システムコンサルタント"],
  ["Designers", "デザイナー"],
  ["Writers, reporters & editors", "著述家"],
];
console.log(
  "\n## Japan: average annual pay including bonus (mean, not median; gross, ¥ and PPP $/year, 2025)\n",
);
console.log(
  `| Where | ${JP_COLUMNS.map(([l]) => l).join(" | ")} |\n| --- |${" ---: |".repeat(JP_COLUMNS.length)}`,
);
for (const [label, city] of [
  ["Tokyo", "Tokyo"],
  ["Osaka", "Osaka"],
  ["Aichi (Nagoya)", "Nagoya"],
  ["Fukuoka", "Fukuoka"],
  ["Japan (national)", "Japan (national)"],
] as const) {
  const cells = JP_COLUMNS.map(([, key]) => {
    const r = data.jp.find(
      (r) => r.city === city && (key.endsWith(")") ? r.measure!.endsWith(key) : has(r, key)),
    );
    if (!r) return "—";
    const yen = jpMeanAnnualYen(r);
    return `¥${(yen / 1e6).toFixed(1)}M (${k(yen / PPP.Japan![2025]!)})`;
  });
  console.log(`| ${label} | ${cells.join(" | ")} |`);
}

// ---------------------------------------------------------------------------
// 7. French-speaking high-wage areas: Switzerland, Luxembourg, Belgium
// ---------------------------------------------------------------------------

console.log(
  "\n## Switzerland by region, 2024 (gross, PPP $/year; monthly pay incl. 1/12 of the 13th month × 12)\n",
);
console.log(
  "| Region | Languages | All jobs, median | IT services: P10 | IT services: median | IT services: P90 | ICT professionals, median |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |",
);
for (const [city, label, langs] of [
  ["Geneva/Lausanne", "Lake Geneva (Geneva, Lausanne)", "French"],
  ["Zurich", "Zurich", "German"],
  ["Basel", "Northwestern Switzerland (Basel)", "German"],
  ["Bern", "Espace Mittelland (Bern)", "German, French"],
  ["Lugano", "Ticino (Lugano)", "Italian"],
] as const) {
  const rows = data.frz.filter((r) => r.city === city);
  const all = one(rows, (r) => has(r, "all economic activities"), `${city} all`);
  const it = one(rows, (r) => has(r, "division 62"), `${city} 62`);
  const ict = one(rows, (r) => has(r, "ISCO-08 sub-major group 25"), `${city} ict`);
  console.log(
    `| ${label} | ${langs} | ${k(annualPpp(all, "median"))} | ${k(annualPpp(it, "p10"))} | ${k(annualPpp(it, "median"))} | ${k(annualPpp(it, "p90"))} | ${k(annualPpp(ict, "median"))} |`,
  );
}

const lux = data.frz.filter((r) => r.country === "Luxembourg");
const luxAll = one(lux, (r) => has(r, "B-S"), "lux all");
const luxJ = one(lux, (r) => has(r, "section J"), "lux J");
console.log("\n## Luxembourg, 2022 (gross annual pay per full-time equivalent, PPP $/year)\n");
console.log("| Sector | P10 | Median | P90 |\n| --- | ---: | ---: | ---: |");
for (const [label, r] of [
  ["All sectors", luxAll],
  ["Information & communication", luxJ],
] as const)
  console.log(
    `| ${label} | ${k(annualPpp(r, "p10"))} | ${k(annualPpp(r, "median"))} | ${k(annualPpp(r, "p90"))} |`,
  );

console.log(
  "\n## Belgium by region, 2022 (October pay × 12, excludes 13th month and holiday pay; PPP $/year)\n",
);
console.log("| Region | Languages | Median, all private-sector jobs |\n| --- | --- | ---: |");
for (const [city, label, langs] of [
  ["Brussels", "Brussels", "French, Dutch"],
  ["Antwerp/Ghent", "Flanders (Antwerp, Ghent)", "Dutch"],
  ["Liège/Charleroi", "Wallonia (Liège, Charleroi)", "French"],
] as const) {
  const r = one(data.frz, (r) => r.city === city, city);
  console.log(`| ${label} | ${langs} | ${k(annualPpp(r, "median"))} |`);
}
