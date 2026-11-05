// /books: the public-domain catalogue, its slugs, the source fetch and cache,
// Project Gutenberg's licence header/footer, and the idempotent import.

import { describe, expect, test } from "bun:test";
import {
  CATALOGUE,
  SOURCE_HOSTS,
  allowedSourceUrl,
  bookKey,
  catalogueBook,
  catalogueByLang,
  bookVisibleIn,
  catalogueFor,
  checkCatalogue,
  presetSourceKey,
  usPdCutoff,
  type CatalogueBook,
} from "@/lib/books/catalogue";
import {
  DEFAULT_TERM,
  TERMS,
  listedCountries,
  normaliseCountry,
  pdForViewer,
  pdIn,
  termFor,
  type Work,
} from "@/lib/books/terms";
import { bookHref, newSlug, normaliseSlug, slugOf, SLUG_RE } from "@/lib/books/slug";
import {
  BookSourceFail,
  cutRange,
  fetchSourceFile,
  loadSource,
  parseSource,
  sourceCacheKey,
  stripGutenberg,
  type SourceCache,
} from "@/lib/books/source";
import { importCatalogueBook, type ImportDeps } from "@/lib/books/import";
import { parseBookMeta } from "@/lib/read/book";
import { booksOn } from "@/lib/books/gate";
import { visibleNav } from "@/lib/app-nav";
import { isAppRoute } from "@/lib/app-locale";

const perrault = CATALOGUE[0];

describe("catalogue", () => {
  test("every entry passes the public-domain rule as of 2026 and names an allowed source", () => {
    expect(checkCatalogue(CATALOGUE, 2026)).toEqual([]);
  });

  test("Perrault is first, and Le Petit Prince / Le Petit Nicolas are not in it", () => {
    expect(perrault.author).toBe("Charles Perrault");
    const titles = CATALOGUE.map((b) => b.title.toLowerCase()).join("|");
    expect(titles).not.toContain("petit prince");
    expect(titles).not.toContain("petit nicolas");
  });

  test("every entry shows a licence and an attribution, and links its source page", () => {
    for (const b of CATALOGUE) {
      expect(b.licence.length).toBeGreaterThan(10);
      expect(b.attribution.length).toBeGreaterThan(10);
      expect(allowedSourceUrl(b.source.page)).not.toBeNull();
      expect(allowedSourceUrl(b.source.file)).not.toBeNull();
    }
  });

  test("the check refuses a recent work, missing data, an unknown host, no licence", () => {
    const bad: CatalogueBook = {
      ...perrault,
      slug: "x",
      workCountry: "France",
      firstPublicationYear: 1943,
      creators: [{ name: "A translator", role: "translator", deathYear: 1950 }],
      source: { ...perrault.source, file: "https://example.com/book.html" },
      licence: "",
    };
    const out = checkCatalogue([bad], 2026).join("\n");
    expect(out).toContain("not public domain in the US");
    expect(out).toContain("workCountry must be an ISO 3166 code");
    expect(out).toContain("not on an allowed host");
    expect(out).toContain("licence line missing");
    const undated = { ...perrault, creators: [{ ...perrault.creators[0], deathYear: NaN }] };
    expect(checkCatalogue([undated], 2026).join()).toContain("death year missing");
  });

  test("the check refuses a work still protected in its own country (US PD alone is not enough)", () => {
    // Published 1925 (US public domain in 2026), author died 1960: still life+70 in France.
    const b = {
      ...perrault,
      firstPublicationYear: 1925,
      creators: [{ name: "X", role: "author" as const, deathYear: 1960 }],
    };
    expect(checkCatalogue([b], 2026).join()).toContain(
      "not public domain in its country of first publication",
    );
    expect(checkCatalogue([b], 2026).join()).not.toContain("not public domain in the US");
  });

  test("the US cutoff moves each year", () => {
    const b = { ...perrault, firstPublicationYear: 1930 };
    expect(usPdCutoff(2026)).toBe(1930);
    expect(checkCatalogue([b], 2026)).toEqual([]);
    expect(checkCatalogue([b], 2025).join()).toContain("not public domain in the US");
  });

  test("every entry is visible in every listed country, and to an unknown viewer, in 2026", () => {
    for (const c of [...listedCountries(), null, "XX", "ZZ"])
      expect(catalogueFor(c, 2026).map(bookKey)).toEqual(CATALOGUE.map(bookKey));
  });

  test("allowed URLs: https on a listed host only", () => {
    expect(SOURCE_HOSTS).toContain("www.gutenberg.org");
    expect(allowedSourceUrl("https://www.gutenberg.org/ebooks/1")).not.toBeNull();
    expect(allowedSourceUrl("http://www.gutenberg.org/ebooks/1")).toBeNull();
    expect(allowedSourceUrl("https://www.gutenberg.org:8443/x")).toBeNull();
    expect(allowedSourceUrl("https://u:p@www.gutenberg.org/x")).toBeNull();
    expect(allowedSourceUrl("https://gutenberg.org.evil.com/x")).toBeNull();
    expect(allowedSourceUrl("not a url")).toBeNull();
  });

  test("grouped by language, easiest level first", () => {
    const groups = catalogueByLang();
    expect(groups[0][0]).toBe("fr");
    const fr = groups[0][1].map((b) => b.level);
    expect(fr[0]).toBe("A1");
    expect(fr.at(-1)).toBe("B1");
  });

  test("lookup by <lang>/<slug>; the source key is preset:<lang>/<slug>", () => {
    expect(catalogueBook(bookKey(perrault))).toBe(perrault);
    expect(catalogueBook("fr/nope")).toBeNull();
    expect(catalogueBook(42)).toBeNull();
    expect(presetSourceKey(perrault)).toBe("preset:fr/histoires-ou-contes-du-temps-passé");
  });

  test("gate: the flag, or the owner while it is off", () => {
    expect(booksOn({}, false)).toBe(false);
    expect(booksOn({}, true)).toBe(true);
    expect(booksOn({ "books.catalogue": true }, false)).toBe(true);
    expect(visibleNav([]).some((i) => i.key === "books")).toBe(false);
    expect(visibleNav(["books"]).some((i) => i.key === "books")).toBe(true);
    expect(isAppRoute("/books")).toBe(true);
  });
});

const work = (workCountry: string, firstPublicationYear: number, ...deaths: number[]): Work => ({
  workCountry,
  firstPublicationYear,
  creators: deaths.map((deathYear, i) => ({ name: `C${i}`, role: "author", deathYear })),
});

describe("copyright terms per country (lib/books/terms.ts)", () => {
  test("the table covers the countries the rule names, with their life terms", () => {
    const life = (c: string) => TERMS[c].life;
    for (const c of ["FR", "DE", "IT", "NL", "SE", "PL", "GB", "BR", "AU", "CA", "KR", "JP"])
      expect(life(c)).toBe(70);
    expect(life("CN")).toBe(50);
    expect(life("IN")).toBe(60);
    expect(life("MX")).toBe(100);
    expect(life("RU")).toBe(74);
    expect(TERMS.US.publication).toEqual({ years: 95, lifeFrom: 2003 });
    expect(DEFAULT_TERM).toMatchObject({ life: 100, andUs: true });
    for (const t of Object.values(TERMS)) expect(t.note.length).toBeGreaterThan(10);
  });

  test("terms run to the end of the calendar year", () => {
    const w = work("FR", 1900, 1955);
    expect(pdIn(w, "FR", 2025)).toBe(false); // protected through 31 Dec 2025
    expect(pdIn(w, "FR", 2026)).toBe(true);
    expect(pdIn(work("CN", 1900, 1975), "CN", 2026)).toBe(true);
    expect(pdIn(work("CN", 1900, 1976), "CN", 2026)).toBe(false);
  });

  test("the last creator to die decides (a translator, an illustrator)", () => {
    expect(pdIn(work("FR", 1900, 1900, 1960), "FR", 2026)).toBe(false);
    expect(pdIn(work("FR", 1900, 1900, 1950), "FR", 2026)).toBe(true);
    expect(pdIn(work("FR", 1900), "FR", 2026)).toBe(false); // no creators: never public domain
  });

  test("US: the publication rule, not the death year", () => {
    expect(pdIn(work("US", 1930, 2000), "US", 2026)).toBe(true);
    expect(pdIn(work("US", 1931, 1900), "US", 2026)).toBe(false);
    expect(pdIn(work("US", 1931, 1900), "US", 2027)).toBe(true);
    expect(pdIn(work("US", 2010, 1940), "US", 2026)).toBe(true); // first published 2003+: life+70
    expect(pdIn(work("US", 2010, 1960), "US", 2026)).toBe(false);
  });

  test("non-retroactive extensions: Japan 2018, Canada 2022, Korea 2013, Australia 2005", () => {
    const jp = (d: number) => pdIn(work("JP", 1920, d), "JP", 2026);
    expect(jp(1967)).toBe(true); // life+50 ended 2017, before the extension
    expect(jp(1968)).toBe(false); // still running in 2018: life+70, to 2038
    const ca = (d: number) => pdIn(work("CA", 1920, d), "CA", 2026);
    expect(ca(1971)).toBe(true);
    expect(ca(1972)).toBe(false);
    expect(pdIn(work("KR", 1920, 1962), "KR", 2026)).toBe(true);
    expect(pdIn(work("KR", 1920, 1963), "KR", 2026)).toBe(false);
    expect(pdIn(work("AU", 1920, 1954), "AU", 2025)).toBe(true);
    expect(pdIn(work("AU", 1920, 1955), "AU", 2025)).toBe(false); // life+70, to 2025
  });

  test("Japan's wartime additions apply to Allied-country works published before 1952", () => {
    // Died 1960: a Japanese work's life+50 ended 2010; a British one's ran 11 more years, past 2018.
    expect(pdIn(work("JP", 1940, 1960), "JP", 2026)).toBe(true);
    expect(pdIn(work("GB", 1940, 1960), "JP", 2026)).toBe(false);
    expect(pdIn(work("GB", 1955, 1960), "JP", 2026)).toBe(true); // published after 1952: no addition
    expect(pdIn(work("GB", 1940, 1956), "JP", 2026)).toBe(true); // 1956+61 = 2017
  });

  test("Spain: life+80 for creators who died by 1987", () => {
    expect(pdIn(work("ES", 1930, 1946), "ES", 2026)).toBe(false);
    expect(pdIn(work("ES", 1930, 1945), "ES", 2026)).toBe(true);
    expect(pdIn(work("ES", 1930, 1945), "FR", 2026)).toBe(true);
  });

  test("an unknown or unlisted country gets the conservative default: life+100 and the US rule", () => {
    for (const c of [null, undefined, "XX", "T1", "", "zz", "France"])
      expect(termFor(c)).toBe(DEFAULT_TERM);
    expect(termFor("fr")).toBe(TERMS.FR);
    expect(normaliseCountry(" jp ")).toBe("JP");
    expect(pdIn(work("FR", 1920, 1925), null, 2026)).toBe(true);
    expect(pdIn(work("FR", 1920, 1926), "ZZ", 2026)).toBe(false);
    expect(pdIn(work("FR", 1931, 1900), "ZZ", 2026)).toBe(false); // not yet PD in the US
  });
});

describe("viewer filtering: public domain in the work's country, the viewer's and the US", () => {
  const kafka = CATALOGUE.find((b) => b.slug === "die-verwandlung")!;

  test("a 1924-death author is hidden in Mexico (life+100) but shown in France, until 2025", () => {
    expect(kafka.creators.map((c) => c.deathYear)).toEqual([1924]);
    expect(bookVisibleIn(kafka, "FR", 2024)).toBe(true);
    expect(bookVisibleIn(kafka, "MX", 2024)).toBe(false);
    expect(bookVisibleIn(kafka, null, 2024)).toBe(false); // unknown viewer: the default, life+100
    expect(catalogueFor("MX", 2024).map(bookKey)).not.toContain(bookKey(kafka));
    expect(catalogueFor("FR", 2024).map(bookKey)).toContain(bookKey(kafka));
    expect(bookVisibleIn(kafka, "MX", 2025)).toBe(true);
  });

  test("today's example: a 1950-death author, published 1925, is shown in France and China, hidden in Mexico", () => {
    const w = work("FR", 1925, 1950);
    expect(pdForViewer(w, "FR", 2026)).toBe(true);
    expect(pdForViewer(w, "CN", 2026)).toBe(true);
    expect(pdForViewer(w, "MX", 2026)).toBe(false);
    // Died 1970, a Chinese work: free at home (life+50), still protected in India (life+60).
    expect(pdForViewer(work("CN", 1925, 1970), "CN", 2026)).toBe(true);
    expect(pdForViewer(work("CN", 1925, 1970), "IN", 2026)).toBe(false);
    expect(pdForViewer(w, null, 2026)).toBe(false);
  });

  test("the work's own country counts even for a viewer where it is free", () => {
    // Died 1960: free in China (life+50), still protected in its French homeland.
    expect(pdForViewer(work("FR", 1925, 1960), "CN", 2026)).toBe(false);
    expect(pdForViewer(work("CN", 1925, 1960), "CN", 2026)).toBe(true);
  });

  test("the US is always required, wherever the viewer is", () => {
    // Published 1935: free by life+50 in China, not yet in the US.
    expect(pdForViewer(work("CN", 1935, 1940), "CN", 2026)).toBe(false);
  });
});

describe("slugs: the title in its own language and script", () => {
  test("French keeps its accents and the apostrophe between letters", () => {
    expect(slugOf("Histoires ou Contes du temps passé")).toBe("histoires-ou-contes-du-temps-passé");
    expect(slugOf("Contes de ma mère l’Oye")).toBe("contes-de-ma-mère-l'oye");
    expect(slugOf("Candide, ou l'optimisme")).toBe("candide-ou-l'optimisme");
    expect(slugOf("« Fables » — livre I !")).toBe("fables-livre-i");
  });

  test("Japanese and Chinese stay in their script", () => {
    expect(slugOf("吾輩は猫である")).toBe("吾輩は猫である");
    expect(slugOf("红楼梦")).toBe("红楼梦");
    expect(slugOf("銀河鉄道の夜　（初期形）")).toBe("銀河鉄道の夜-初期形");
  });

  test("NFC: a decomposed é gives the same slug", () => {
    expect(slugOf("passé")).toBe(slugOf("passé"));
  });

  test("stable: made once; a collision gets the first free meaningful suffix", () => {
    const taken = new Set(["fables"]);
    expect(newSlug("Fables", new Set())).toBe("fables");
    expect(newSlug("Fables", taken, ["La Fontaine", "1668"])).toBe("fables-la-fontaine");
    taken.add("fables-la-fontaine");
    expect(newSlug("Fables", taken, ["La Fontaine", "1668"])).toBe("fables-1668");
    taken.add("fables-1668");
    expect(newSlug("Fables", taken, ["La Fontaine", "1668"])).toBeNull();
    expect(newSlug("!!!", new Set())).toBeNull();
  });

  test("every stored slug is in its own normal form", () => {
    for (const b of CATALOGUE) {
      expect(SLUG_RE.test(b.slug)).toBe(true);
      expect(slugOf(b.slug)).toBe(b.slug);
    }
  });

  test("links encode, the route decodes and normalises back to the stored slug", () => {
    for (const slug of [
      "histoires-ou-contes-du-temps-passé",
      "吾輩は猫である",
      "candide-ou-l'optimisme",
    ]) {
      const href = bookHref({ lang: "fr", slug });
      expect(href).not.toMatch(/[^\x21-\x7e]/);
      const seg = href.split("/").at(-1)!;
      expect(normaliseSlug(seg)).toBe(slug);
      expect(normaliseSlug(slug)).toBe(slug);
    }
    expect(normaliseSlug(encodeURIComponent("passé"))).toBe("passé");
    expect(normaliseSlug("%E0%A4%A")).toBeNull();
    expect(normaliseSlug("a/b")).toBeNull();
  });
});

const HTML = (body: string) =>
  `<!DOCTYPE html><html lang="fr"><head><title>x</title></head><body>${body}</body></html>`;

const PG_FILE = HTML(
  `<header class="pg-boilerplate pgheader" id="pg-header" lang="en"><h2 id="pg-header-heading">The Project Gutenberg eBook of Contes</h2><p>This ebook is for the use of anyone anywhere in the United States</p><div id="pg-start-separator"><span>*** START OF THE PROJECT GUTENBERG EBOOK CONTES ***</span></div></header>` +
    `<h1>Préface en anglais</h1><p>An English preface.</p>` +
    `<h2><a id="belle"></a>LA BELLE<br>AU BOIS DORMANT</h2><p>Il estoit une fois un Roi et une Reine.</p>` +
    `<h2><a id="rouge"></a>LE PETIT CHAPERON ROUGE</h2><p>Il estoit une fois une petite fille de Village.</p>` +
    `<h2><a id="fees"></a>LES FÉES</h2><p>Il estoit une fois une veuve.</p>` +
    `<p class="center"><i>Extrait du Privilége du Roy.</i></p><p>Par grace et privilége du Roy.</p>` +
    `<footer class="pg-boilerplate pgheader" id="pg-footer" lang="en"><div id="pg-end-separator"><span>*** END OF THE PROJECT GUTENBERG EBOOK CONTES ***</span></div><h2>THE FULL PROJECT GUTENBERG LICENSE</h2><p>Project Gutenberg is a registered trademark.</p></footer>`,
);

const entry: CatalogueBook = {
  ...perrault,
  range: { from: "belle", toMarkup: "<i>Extrait du Privil" },
};

describe("Project Gutenberg files", () => {
  test("the licence header and footer are removed", () => {
    const out = stripGutenberg(PG_FILE);
    expect(out).not.toContain("Project Gutenberg");
    expect(out).toContain("LA BELLE");
    expect(out).toContain("Privilége du Roy");
  });

  test("older files: everything outside the START / END lines is removed", () => {
    const old = HTML(
      `<pre>The Project Gutenberg EBook of X\n*** START OF THIS PROJECT GUTENBERG EBOOK X ***</pre><p>Le texte.</p><pre>*** END OF THIS PROJECT GUTENBERG EBOOK X ***\nLicense…</pre>`,
    );
    const out = stripGutenberg(old);
    expect(out).toContain("Le texte.");
    expect(out).not.toMatch(/gutenberg/i);
  });

  test("range: from an anchor's heading up to a marker's paragraph", () => {
    const out = cutRange(stripGutenberg(PG_FILE), entry.range);
    expect(out).toContain('<h2><a id="belle">');
    expect(out).not.toContain("English preface");
    expect(out).not.toContain("Privilége");
    expect(out).toContain("<title>x</title>");
  });

  test("parsed: titled and credited from the entry, a broken heading is one chapter", () => {
    const b = parseSource(entry, PG_FILE);
    expect(b.title).toBe(entry.title);
    expect(b.author).toBe("Charles Perrault");
    expect(b.lang).toBe("fr");
    expect(b.lines.join("\n")).not.toMatch(/gutenberg/i);
    expect(b.chapters.map((c) => c.title)).toEqual([
      "LA BELLE AU BOIS DORMANT",
      "LE PETIT CHAPERON ROUGE",
      "LES FÉES",
    ]);
  });
});

/** A fetch that answers from a table of URL → Response factories, and counts calls. */
function mockFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(init?.redirect).toBe("manual");
    const r = routes[url];
    if (!r) return new Response("no", { status: 404 });
    return r();
  }) as typeof fetch;
  return { f, calls };
}

const html200 =
  (body = PG_FILE) =>
  () =>
    new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

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

describe("source fetch", () => {
  test("fetches the entry's own file", async () => {
    const { f, calls } = mockFetch({ [entry.source.file]: html200() });
    expect(await fetchSourceFile(entry, f)).toBe(PG_FILE);
    expect(calls).toEqual([entry.source.file]);
  });

  test("follows a redirect within the source hosts only", async () => {
    const other = "https://www.gutenberg.org/files/33931/33931-h/33931-h.htm";
    const ok = mockFetch({
      [entry.source.file]: () => new Response(null, { status: 302, headers: { location: other } }),
      [other]: html200(),
    });
    expect(await fetchSourceFile(entry, ok.f)).toBe(PG_FILE);

    const off = mockFetch({
      [entry.source.file]: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    });
    await expect(fetchSourceFile(entry, off.f)).rejects.toThrow(BookSourceFail);
    expect(off.calls).toHaveLength(1);
  });

  test("refuses non-HTML, errors and a file over the size cap", async () => {
    const txt = mockFetch({
      [entry.source.file]: () =>
        new Response("x", { status: 200, headers: { "content-type": "application/zip" } }),
    });
    await expect(fetchSourceFile(entry, txt.f)).rejects.toThrow("fetch-failed");
    const err = mockFetch({ [entry.source.file]: () => new Response("x", { status: 500 }) });
    await expect(fetchSourceFile(entry, err.f)).rejects.toThrow("fetch-failed");
    const big = mockFetch({ [entry.source.file]: html200("x".repeat(2000)) });
    await expect(
      fetchSourceFile(entry, big.f, { maxBytes: 1000, maxRedirects: 3, timeoutMs: 5000 }),
    ).rejects.toThrow("too-large");
  });

  test("a second load comes from the cache, not the source", async () => {
    const cache = memoryCache();
    const { f, calls } = mockFetch({ [entry.source.file]: html200() });
    const a = await loadSource(entry, cache, f);
    const b = await loadSource(entry, cache, f);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(calls).toHaveLength(1);
    const key = await sourceCacheKey(entry);
    expect(key.startsWith("preset-cache/fr/")).toBe(true);
    expect(cache.data.get(key)).toBe(PG_FILE);
  });

  test("a failing cache does not stop the import", async () => {
    const broken: SourceCache = {
      get: async () => {
        throw new Error("r2 down");
      },
      put: async () => {
        throw new Error("r2 down");
      },
    };
    const { f } = mockFetch({ [entry.source.file]: html200() });
    expect((await loadSource(entry, broken, f)).html).toBe(PG_FILE);
  });
});

describe("import", () => {
  function deps(fetchImpl: typeof fetch) {
    const rows = new Map<string, { id: string; content: string; lines: string[] }>();
    let n = 0;
    const d: ImportDeps = {
      find: async (uid, key) => {
        const r = rows.get(`${uid}|${key}`);
        return r ? { id: r.id } : null;
      },
      save: async (uid, _title, content, lines, _hash, key) => {
        const id = `m${++n}`;
        rows.set(`${uid}|${key}`, { id, content, lines });
        return { id };
      },
      cache: memoryCache(),
      fetchImpl,
    };
    return { d, rows };
  }

  test("importing the same book twice opens the first copy; each user gets their own", async () => {
    const { f, calls } = mockFetch({ [entry.source.file]: html200() });
    const { d, rows } = deps(f);
    const a = await importCatalogueBook("u1", entry, d);
    const b = await importCatalogueBook("u1", entry, d);
    expect(a.existing).toBe(false);
    expect(b).toEqual({ id: a.id, existing: true });
    const c = await importCatalogueBook("u2", entry, d);
    expect(c.existing).toBe(false);
    expect(c.id).not.toBe(a.id);
    expect(c.cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect(rows.size).toBe(2);
  });

  test("the imported book carries its source link, licence and attribution", async () => {
    const { f } = mockFetch({ [entry.source.file]: html200() });
    const { d, rows } = deps(f);
    await importCatalogueBook("u1", entry, d);
    const row = [...rows.values()][0];
    const meta = parseBookMeta(row.content)!;
    expect(meta.source).toBe("preset");
    expect(meta.sourceUrl).toBe(entry.source.page);
    expect(meta.credit).toEqual({
      preset: bookKey(entry),
      sourceName: "Project Gutenberg",
      licence: entry.licence,
      attribution: entry.attribution,
    });
    expect(meta.author).toBe("Charles Perrault");
    expect(row.lines.join("\n")).not.toMatch(/gutenberg/i);
  });

  test("stored meta: a source link off the source hosts is dropped with its credit", () => {
    const content = JSON.stringify({
      kind: "lianki-book",
      v: 1,
      source: "preset",
      sourceUrl: "https://evil.example/x",
      credit: { preset: "fr/x", sourceName: "S", licence: "Public domain", attribution: "A B C" },
      chapters: [],
    });
    const meta = parseBookMeta(content)!;
    expect(meta.sourceUrl).toBeUndefined();
    expect(meta.credit).toBeUndefined();
  });
});
