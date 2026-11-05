// /books: a pasted link or a search hit → the host's facts → the admission
// rule → an import (docs/books-plan.md, "Paste a link, or search the
// libraries"). All metadata here is small synthetic data, mocked per host.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { CATALOGUE, bookKey, catalogueBook, type CatalogueBook } from "@/lib/books/catalogue";
import {
  aozoraFacts,
  displayName,
  entryForLink,
  fetchMeta,
  gutenbergFacts,
  gutenbergPerson,
  judge,
  languageCode,
  originalPublication,
  parseBookLink,
  wikisourceFacts,
  type WorkFacts,
} from "@/lib/books/resolve";
import { entryToImport, resolveLink, searchLibraries } from "@/lib/books/lookup";
import {
  aozoraIndex,
  cleanQuery,
  csvFields,
  searchAozoraIndex,
  fetchZip,
  unzipOne,
} from "@/lib/books/search";
import { d1SharedStore, mergeCatalogue, parseEntry, type SharedStore } from "@/lib/books/shared";
import { createTestD1 } from "@/lib/d1/testDb";
import type { SourceCache } from "@/lib/books/source";

const YEAR = 2026;

/** A Project Gutenberg ebook page reduced to its bibliographic record. */
const pgPage = (rows: [string, string][]) =>
  `<html><body><table class="bibrec">${rows
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("")}</table></body></html>`;

const POTTER_LIKE = pgPage([
  ["Author", '<a href="/ebooks/author/1">Writer, Ada, 1850-1910</a>'],
  ["Illustrator", "Painter, Bob, 1845-1920"],
  ["Title", "A Little Tale"],
  ["Language", "English"],
  ["Original Publication", "London: Frederick Warne and Co., 1902."],
  ["Copyright Status", "Public domain in the USA."],
]);

function memoryShared(): SharedStore & { rows: Map<string, CatalogueBook> } {
  const rows = new Map<string, CatalogueBook>();
  return {
    rows,
    async list() {
      return [...rows.values()];
    },
    async byLink(link) {
      return rows.get(link) ?? null;
    },
    async byKey(lang, slug) {
      return [...rows.values()].find((b) => b.lang === lang && b.slug === slug) ?? null;
    },
    async add(link, book) {
      if (!rows.has(link)) rows.set(link, book);
      return rows.get(link)!;
    },
  };
}

function memoryCache(): SourceCache & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) {
      return data.get(k) ?? null;
    },
    async put(k, v) {
      data.set(k, v);
    },
  };
}

/** A fetch answering from URL → body (HTML or JSON), counting calls; anything else 404s. */
function hosts(routes: Record<string, string>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("no", { status: 404 });
    const json = body.startsWith("{");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": json ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      },
    });
  }) as typeof fetch;
  return { f, calls };
}

describe("links: only book pages on the hosts we read", () => {
  test("Gutenberg, Aozora and Wikisource links reduce to a host and an id", () => {
    expect(parseBookLink("https://www.gutenberg.org/ebooks/33931")).toEqual({
      host: "gutenberg",
      id: 33931,
    });
    expect(parseBookLink("http://gutenberg.org/cache/epub/11/pg11-images.html")).toEqual({
      host: "gutenberg",
      id: 11,
    });
    expect(parseBookLink("https://www.gutenberg.org/ebooks/11.epub3.images")).toEqual({
      host: "gutenberg",
      id: 11,
    });
    expect(parseBookLink("https://www.aozora.gr.jp/cards/000148/card752.html")).toEqual({
      host: "aozora",
      person: "000148",
      card: 752,
    });
    expect(
      parseBookLink("https://www.aozora.gr.jp/cards/000148/files/752_14964.html"),
    ).toMatchObject({ card: 752 });
    expect(parseBookLink("https://zh.m.wikisource.org/wiki/%E8%83%8C%E5%BD%B1")).toEqual({
      host: "wikisource",
      site: "zh.wikisource.org",
      title: "背影",
    });
  });

  test("anything else is refused: other hosts, other pages, credentials, namespaces", () => {
    for (const bad of [
      "https://example.com/ebooks/1",
      "https://gutenberg.org.evil.com/ebooks/1",
      "https://www.gutenberg.org/ebooks/search/?query=x",
      "https://u:p@www.gutenberg.org/ebooks/1",
      "https://xx.wikisource.org/wiki/Foo",
      "https://zh.wikisource.org/wiki/Author:%E9%AD%AF%E8%BF%85",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(parseBookLink(bad)).toBeNull();
  });

  test("a link to a curated work resolves to that entry", () => {
    const perrault = entryForLink(parseBookLink("https://www.gutenberg.org/ebooks/33931")!);
    expect(perrault?.slug).toBe("histoires-ou-contes-du-temps-passé");
    expect(
      entryForLink(parseBookLink("https://www.aozora.gr.jp/cards/000148/files/752_14964.html")!)
        ?.slug,
    ).toBe("坊っちゃん");
  });
});

describe("facts as each host states them", () => {
  test("Gutenberg: people with dates and roles, the edition's place and year, the US line", () => {
    const f = gutenbergFacts(99, POTTER_LIKE)!;
    expect(f.title).toBe("A Little Tale");
    expect(f.author).toBe("Ada Writer");
    expect(f.lang).toBe("en");
    expect(f.creators).toEqual([
      { name: "Ada Writer", role: "author", deathYear: 1910 },
      { name: "Bob Painter", role: "illustrator", deathYear: 1920 },
    ]);
    expect(f).toMatchObject({
      firstPublicationYear: 1902,
      workCountry: "GB",
      usPublicDomain: true,
      translation: false,
    });
    expect(f.source.file).toBe("https://www.gutenberg.org/cache/epub/99/pg99-images.html");
  });

  test("names, dates and places", () => {
    expect(displayName("Baum, L. Frank (Lyman Frank)")).toBe("L. Frank Baum");
    expect(gutenbergPerson("Confucius, 552 BCE-480 BCE")).toEqual({
      name: "Confucius",
      deathYear: -480,
    });
    expect(gutenbergPerson("Thilo-Luyken, M.").deathYear).toBeNull();
    expect(
      gutenbergPerson("Wu, Cheng'en, approximately 1500-approximately 1582").deathYear,
    ).toBeNull();
    expect(originalPublication("Leipzig [etc.]: Insel, 1913.")).toEqual({
      year: 1913,
      country: "DE",
    });
    expect(originalPublication("Cambridge: University Press, 1910.").country).toBeNull(); // ambiguous
    expect(languageCode("German")).toBe("de");
    expect(languageCode("Klingon")).toBeNull();
  });

  test("Aozora: a card's people with 没年, 初出, the XHTML file and its volunteers", () => {
    const card = `<table summary="タイトルデータ"><tr><td class="header">作品名：</td><td><font size="+2">題</font></td></tr>
      <tr><td class="header">初出：</td><td>「赤い鳥」1920（大正9）年7月号</td></tr></table>
      <table summary="作家データ"><tr><td class="header">分類：</td><td>著者</td></tr>
      <tr><td class="header">作家名：</td><td>芥川 竜之介</td></tr><tr><td class="header">没年：</td><td>1927-07-24</td></tr></table>
      <table summary="底本データ"><tr><td class="header">底本：</td><td>蜘蛛の糸・杜子春</td></tr></table>
      <table summary="工作員データ"><tr><td class="header">入力：</td><td>蒋龍</td></tr><tr><td class="header">校正：</td><td>noriko saito</td></tr></table>
      <a href="./files/43015_17432.html">XHTML</a>`;
    const f = aozoraFacts({ host: "aozora", person: "000879", card: 43015 }, card)!;
    expect(f).toMatchObject({
      title: "題",
      author: "芥川竜之介",
      lang: "ja",
      firstPublicationYear: 1920,
      workCountry: "JP",
      translation: false,
    });
    expect(f.creators).toEqual([{ name: "芥川竜之介", role: "author", deathYear: 1927 }]);
    expect(f.source.file).toBe("https://www.aozora.gr.jp/cards/000879/files/43015_17432.html");
    expect(f.attribution).toContain("入力：蒋龍");
    expect(judge(f, "JP", YEAR).ok).toBe(true);
    const noFirst = aozoraFacts(
      { host: "aozora", person: "000879", card: 1 },
      card.replace(/初出[\s\S]*?<\/tr>/, ""),
    )!;
    expect(judge(noFirst, "JP", YEAR)).toMatchObject({
      ok: false,
      reason: "missing-first-publication",
    });
  });

  test("Wikisource: the edition's Wikidata item, its work, the people's death years, the country", async () => {
    const wd = (ids: string) =>
      `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims%7Clabels&ids=${ids}`;
    const time = (y: number) => ({
      mainsnak: { datavalue: { value: { time: `+${y}-01-01T00:00:00Z`, precision: 9 } } },
    });
    const item = (id: string) => ({ mainsnak: { datavalue: { value: { id } } } });
    const { f } = hosts({
      "https://zh.wikisource.org/w/api.php?action=query&format=json&formatversion=2&prop=pageprops%7Crevisions&rvprop=ids&redirects=1&titles=%E8%83%8C%E5%BD%B1":
        JSON.stringify({
          query: {
            pages: [
              { title: "背影", pageprops: { wikibase_item: "Q1" }, revisions: [{ revid: 42 }] },
            ],
          },
        }),
      [wd("Q1")]: JSON.stringify({
        entities: { Q1: { id: "Q1", claims: { P629: [item("Q2")] } } },
      }),
      [wd("Q2")]: JSON.stringify({
        entities: {
          Q2: { id: "Q2", claims: { P50: [item("Q3")], P577: [time(1925)], P495: [item("Q4")] } },
        },
      }),
      [wd("Q3%7CQ4")]: JSON.stringify({
        entities: {
          Q3: { id: "Q3", labels: { zh: { value: "朱自清" } }, claims: { P570: [time(1948)] } },
          Q4: { id: "Q4", claims: { P297: [{ mainsnak: { datavalue: { value: "CN" } } }] } },
        },
      }),
    });
    const facts = (await wikisourceFacts(
      { host: "wikisource", site: "zh.wikisource.org", title: "背影" },
      (u) => fetchMeta(u, f),
    ))!;
    expect(facts).toMatchObject({
      title: "背影",
      author: "朱自清",
      lang: "zh",
      firstPublicationYear: 1925,
      workCountry: "CN",
    });
    expect(facts.creators).toEqual([{ name: "朱自清", role: "author", deathYear: 1948 }]);
    expect(facts.source.file).toBe(
      "https://zh.wikisource.org/api/rest_v1/page/html/%E8%83%8C%E5%BD%B1/42",
    );
    expect(judge(facts, "CN", YEAR).ok).toBe(true);
    expect(judge(facts, "MX", YEAR)).toMatchObject({ ok: false, reason: "not-public-domain-here" });
  });
});

describe("the rule on stated facts: anything missing or uncertain refuses", () => {
  const base = gutenbergFacts(99, POTTER_LIKE)!;
  const with_ = (p: Partial<WorkFacts>): WorkFacts => ({ ...base, ...p });

  test("PD everywhere it needs to be: an entry with a slug in the title's own script", () => {
    const v = judge(base, "FR", YEAR);
    expect(v).toMatchObject({
      ok: true,
      curated: false,
      book: { slug: "a-little-tale", lang: "en", level: "" },
    });
  });

  test("a missing death year, first publication, country or language refuses with that reason", () => {
    const noDeath = with_({
      creators: [...base.creators, { name: "Someone", role: "editor", deathYear: null }],
    });
    expect(judge(noDeath, "FR", YEAR)).toMatchObject({
      ok: false,
      reason: "missing-death-year",
      detail: "Someone",
    });
    expect(judge(with_({ firstPublicationYear: null }), "FR", YEAR)).toMatchObject({
      reason: "missing-first-publication",
    });
    expect(judge(with_({ workCountry: null }), "FR", YEAR)).toMatchObject({
      reason: "missing-country",
    });
    expect(judge(with_({ lang: null }), "FR", YEAR)).toMatchObject({ reason: "missing-language" });
    expect(judge(with_({ creators: [] }), "FR", YEAR)).toMatchObject({
      reason: "missing-death-year",
    });
  });

  test("translations, unknown roles, and works still protected are refused", () => {
    expect(judge(with_({ translation: true }), "FR", YEAR)).toMatchObject({
      reason: "translation",
    });
    expect(judge(with_({ unknownRole: "Arranger" }), "FR", YEAR)).toMatchObject({
      reason: "unknown-role",
    });
    expect(judge(with_({ firstPublicationYear: 1935 }), "FR", YEAR)).toMatchObject({
      reason: "not-public-domain-us",
    });
    const late = with_({ creators: [{ name: "Late", role: "author", deathYear: 1960 }] });
    expect(judge(late, "FR", YEAR)).toMatchObject({ reason: "not-public-domain-origin" });
    const died1930 = with_({ creators: [{ name: "Ada Writer", role: "author", deathYear: 1930 }] });
    expect(judge(died1930, "FR", YEAR).ok).toBe(true);
    expect(judge(died1930, "MX", YEAR)).toMatchObject({ reason: "not-public-domain-here" }); // life+100
    expect(judge(with_({ usPublicDomain: false }), "FR", YEAR)).toMatchObject({
      reason: "not-public-domain-us",
    });
  });
});

describe("resolve → import: one path for pasted links and search hits", () => {
  test("the owner's first case: Perrault's PG #33931 is the curated entry, nothing fetched", async () => {
    const { f, calls } = hosts({});
    const shared = memoryShared();
    const r = await resolveLink("https://www.gutenberg.org/ebooks/33931", "FR", YEAR, {
      shared,
      cache: null,
      fetchImpl: f,
    });
    expect(calls).toEqual([]);
    expect(r.verdict).toMatchObject({ ok: true, curated: true });
    const entry = await entryToImport(r, { shared, cache: null });
    expect(entry && bookKey(entry)).toBe("fr/histoires-ou-contes-du-temps-passé");
    expect(shared.rows.size).toBe(0); // not duplicated into the shared list
    // Its facts as Gutenberg states them pass the same rule (creators incl. Lang, the editor).
    const pg = gutenbergFacts(
      33931,
      pgPage([
        ["Author", "Perrault, Charles, 1628-1703"],
        ["Editor", "Lang, Andrew, 1844-1912"],
        ["Title", "Popular Tales"],
        ["Language", "French"],
        ["Original Publication", "Oxford: Clarendon Press, 1888."],
        ["Copyright Status", "Public domain in the USA."],
      ]),
    )!;
    expect(pg.creators.map((c) => [c.role, c.deathYear])).toEqual([
      ["author", 1703],
      ["editor", 1912],
    ]);
    expect(judge(pg, "FR", YEAR).ok).toBe(true);
  });

  test("a confirmed new work becomes one shared entry; the facts are read once (cached)", async () => {
    const { f, calls } = hosts({
      "https://www.gutenberg.org/ebooks/99": POTTER_LIKE,
      "https://www.gutenberg.org/cache/epub/99/pg99-images.html":
        "<html><body><h2>One</h2><p>A tale.</p></body></html>",
    });
    const shared = memoryShared();
    const cache = memoryCache();
    const deps = { shared, cache, fetchImpl: f };
    const r = await resolveLink("https://www.gutenberg.org/ebooks/99", "FR", YEAR, deps);
    expect(r.verdict.ok).toBe(true);
    const e = (await entryToImport(r, deps))!;
    expect(bookKey(e)).toBe("en/a-little-tale");
    expect(shared.rows.get("gutenberg:99")).toBe(e);
    const again = await resolveLink("https://www.gutenberg.org/ebooks/99", "FR", YEAR, deps);
    expect(again.verdict).toMatchObject({ ok: true, curated: true }); // now the shared entry
    expect(calls).toHaveLength(2); // the page once (cached), the book's file once
  });

  test("a work whose file the importer cannot read is not listed", async () => {
    const shared = memoryShared();
    const { f } = hosts({ "https://www.gutenberg.org/ebooks/99": POTTER_LIKE });
    const deps = { shared, cache: null, fetchImpl: f };
    const r = await resolveLink("https://www.gutenberg.org/ebooks/99", "FR", YEAR, deps);
    await expect(entryToImport(r, deps)).rejects.toThrow("fetch-failed");
    expect(shared.rows.size).toBe(0);
  });

  test("missing death year → refused; a host off the list → bad link; an unknown page → not found", async () => {
    const page = POTTER_LIKE.replace("Painter, Bob, 1845-1920", "Painter, Bob");
    const deps = {
      shared: memoryShared(),
      cache: null,
      fetchImpl: hosts({ "https://www.gutenberg.org/ebooks/98": page }).f,
    };
    expect(
      (await resolveLink("https://www.gutenberg.org/ebooks/98", "FR", YEAR, deps)).verdict,
    ).toMatchObject({
      ok: false,
      reason: "missing-death-year",
    });
    expect((await resolveLink("https://example.com/book", "FR", YEAR, deps)).verdict).toMatchObject(
      { reason: "bad-link" },
    );
    expect(
      (await resolveLink("https://www.gutenberg.org/ebooks/97", "FR", YEAR, deps)).verdict,
    ).toMatchObject({
      reason: "not-found",
    });
    expect((await resolveLink(42, "FR", YEAR, deps)).verdict).toMatchObject({ reason: "bad-link" });
  });

  test("metadata fetches stay on the allowed hosts, redirects included", async () => {
    const f = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/x" },
      })) as unknown as typeof fetch;
    await expect(fetchMeta("https://www.gutenberg.org/ebooks/1", f)).rejects.toThrow(
      "fetch-failed",
    );
    await expect(fetchMeta("https://evil.example/x")).rejects.toThrow("fetch-failed");
  });
});

describe("library search", () => {
  test("queries are cleaned; one-letter or empty queries ask nothing", () => {
    expect(cleanQuery("  Peter   Rabbit ")).toBe("Peter Rabbit");
    expect(cleanQuery("a")).toBe("");
    expect(cleanQuery(null)).toBe("");
    expect(cleanQuery("x".repeat(500)).length).toBe(80);
  });

  test("Aozora's index: CSV with quotes, one row per work, works in copyright left out", () => {
    expect(csvFields('a,"b,c","d ""e"""')).toEqual(["a", "b,c", 'd "e"']);
    const csv = [
      "作品ID,作品名,作品著作権フラグ,図書カードURL,姓,名,役割フラグ",
      "43015,杜子春,なし,https://www.aozora.gr.jp/cards/000879/card43015.html,芥川,竜之介,著者",
      "1,新しい本,あり,https://www.aozora.gr.jp/cards/000001/card1.html,誰,か,著者",
      '2,"翻訳の, 本",なし,https://www.aozora.gr.jp/cards/000002/card2.html,訳,者,翻訳者',
    ].join("\n");
    const rows = aozoraIndex(csv);
    expect(rows).toHaveLength(3);
    expect(searchAozoraIndex(rows, "杜子春").map((h) => h.url)).toEqual([
      "https://www.aozora.gr.jp/cards/000879/card43015.html",
    ]);
    expect(searchAozoraIndex(rows, "新しい")).toEqual([]);
    expect(searchAozoraIndex(rows, "翻訳")[0].author).toBe("訳者（翻訳者）");
  });

  test("a one-file zip is read with the platform's inflate", async () => {
    const body = new TextEncoder().encode("作品ID,作品名\n1,本\n");
    const deflated = new Uint8Array(
      await new Response(
        new Blob([body]).stream().pipeThrough(new CompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );
    const name = new TextEncoder().encode("x.csv");
    const head = new Uint8Array(30);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 8, true);
    dv.setUint32(18, deflated.byteLength, true);
    dv.setUint32(22, body.byteLength, true);
    dv.setUint16(26, name.byteLength, true);
    const zip = new Uint8Array([...head, ...name, ...deflated]);
    expect(new TextDecoder().decode(await unzipOne(zip))).toBe("作品ID,作品名\n1,本\n");
    await expect(unzipOne(new Uint8Array(40))).rejects.toThrow();
  });

  test("hits from every library, deduplicated; a failing library is left out", async () => {
    const { f } = hosts({
      "https://gutendex.com/books/?search=tale": JSON.stringify({
        results: [
          {
            id: 99,
            title: "A Little Tale",
            authors: [{ name: "Writer, Ada" }],
            languages: ["en"],
            copyright: false,
          },
          { id: 98, title: "Protected", authors: [], languages: ["en"], copyright: true },
        ],
      }),
      "https://zh.wikisource.org/w/api.php?action=query&format=json&formatversion=2&list=search&srnamespace=0&srlimit=3&srsearch=tale":
        JSON.stringify({ query: { search: [{ title: "背影" }] } }),
      // ru.wikisource and Aozora answer 404 here: left out, not an error.
    });
    const hits = await searchLibraries("tale", {
      shared: memoryShared(),
      cache: memoryCache(),
      fetchImpl: f,
    });
    expect(hits.map((h) => h.url)).toEqual([
      "https://www.gutenberg.org/ebooks/99",
      "https://zh.wikisource.org/wiki/%E8%83%8C%E5%BD%B1",
    ]);
    expect(hits[0].author).toBe("Ada Writer");
  });
});

describe("the shared catalogue (D1)", () => {
  const schema = readFileSync("db/migrations/0039_shared_books.sql", "utf8");

  test("one entry per work; a taken slug gets a meaningful suffix; curated keys win", async () => {
    const store = d1SharedStore(createTestD1(schema));
    const f = gutenbergFacts(99, POTTER_LIKE)!;
    const v = judge(f, "FR", YEAR);
    if (!v.ok) throw new Error("expected ok");
    const a = await store.add("gutenberg:99", v.book);
    expect(await store.add("gutenberg:99", { ...v.book, title: "Other" })).toEqual(a);
    const b = await store.add("gutenberg:100", v.book);
    expect(b.slug).toBe("a-little-tale-ada-writer");
    expect((await store.list()).map(bookKey)).toEqual([
      "en/a-little-tale",
      "en/a-little-tale-ada-writer",
    ]);
    expect((await store.byKey("en", "a-little-tale"))?.title).toBe("A Little Tale");
    const clash = { ...a, lang: "fr", slug: CATALOGUE[0].slug };
    expect(
      mergeCatalogue([clash]).filter((x) => bookKey(x) === bookKey(CATALOGUE[0])),
    ).toHaveLength(1);
    expect(parseEntry("{}")).toBeNull();
    expect(parseEntry("nope")).toBeNull();
    expect(catalogueBook("en/a-little-tale")).toBeNull(); // curated lookup is unchanged
  });
});

describe("caches and failures", () => {
  test("cached facts are reused while fresh, read again when stale; a broken cache is skipped", async () => {
    const { f, calls } = hosts({ "https://www.gutenberg.org/ebooks/99": POTTER_LIKE });
    const cache = memoryCache();
    const deps = { shared: memoryShared(), cache, fetchImpl: f, now: 0 };
    await resolveLink("https://www.gutenberg.org/ebooks/99", "FR", YEAR, deps);
    await resolveLink("https://www.gutenberg.org/ebooks/99", "FR", YEAR, { ...deps, now: 1000 });
    expect(calls).toHaveLength(1);
    await resolveLink("https://www.gutenberg.org/ebooks/99", "FR", YEAR, {
      ...deps,
      now: 30 * 86_400_000,
    });
    expect(calls).toHaveLength(2);
    const broken: SourceCache = {
      get: async () => {
        throw new Error("r2 down");
      },
      put: async () => {
        throw new Error("r2 down");
      },
    };
    const r = await resolveLink("https://www.gutenberg.org/ebooks/99", "FR", YEAR, {
      shared: memoryShared(),
      cache: broken,
      fetchImpl: f,
    });
    expect(r.verdict.ok).toBe(true);
  });

  test("a shared work is judged for the viewer like any entry", async () => {
    const shared = memoryShared();
    const v = judge(gutenbergFacts(99, POTTER_LIKE)!, "FR", YEAR);
    if (!v.ok) throw new Error("expected ok");
    shared.rows.set("gutenberg:99", {
      ...v.book,
      creators: [{ name: "X", role: "author", deathYear: 1930 }],
    });
    const r = await resolveLink("https://www.gutenberg.org/ebooks/99", "MX", YEAR, {
      shared,
      cache: null,
    });
    expect(r.verdict).toMatchObject({ ok: false, reason: "not-public-domain-here" });
  });

  test("every library failing is an error, not an empty answer; Aozora's index comes from its zip", async () => {
    await expect(
      searchLibraries("tale", { shared: memoryShared(), cache: null, fetchImpl: hosts({}).f }),
    ).rejects.toThrow("every library failed");
    const csv = new TextEncoder().encode(
      "作品ID,作品名,作品著作権フラグ,図書カードURL,姓,名,役割フラグ\n42,鼻,なし,https://www.aozora.gr.jp/cards/000879/card42.html,芥川,竜之介,著者\n",
    );
    const name = new TextEncoder().encode("a.csv");
    const head = new Uint8Array(30);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint32(18, csv.byteLength, true); // stored (method 0)
    dv.setUint16(26, name.byteLength, true);
    const zip = new Uint8Array([...head, ...name, ...csv]);
    const f = (async (input: RequestInfo | URL) =>
      String(input).endsWith(".zip")
        ? new Response(zip, { status: 200 })
        : new Response("no", { status: 404 })) as typeof fetch;
    const hits = await searchLibraries("芥川", {
      shared: memoryShared(),
      cache: memoryCache(),
      fetchImpl: f,
    });
    expect(hits.map((h) => h.url)).toEqual(["https://www.aozora.gr.jp/cards/000879/card42.html"]);
  });

  test("the index fetch: only Aozora's index pages, no redirects, size-capped", async () => {
    await expect(fetchZip("https://evil.example/x.zip")).rejects.toThrow("fetch-failed");
    const url = "https://www.aozora.gr.jp/index_pages/x.zip";
    const redirect = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    await expect(fetchZip(url, redirect)).rejects.toThrow("fetch-failed");
    const big = (async () =>
      new Response(new Uint8Array(20), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchZip(url, big, 10)).rejects.toThrow("too-large");
    const throws = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(fetchZip(url, throws)).rejects.toThrow("fetch-failed");
    // Sizes in the data descriptor: read up to the central directory.
    const name = new TextEncoder().encode("a");
    const head = new Uint8Array(30);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(26, 1, true);
    const body = new TextEncoder().encode("abc");
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint32(16, 30 + 1 + 3, true);
    const zip = new Uint8Array([...head, ...name, ...body, ...end]);
    expect(new TextDecoder().decode(await unzipOne(zip))).toBe("abc");
  });
});
