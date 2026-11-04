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
  checkCatalogue,
  presetSourceKey,
  type CatalogueBook,
} from "@/lib/books/catalogue";
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

  test("the check refuses a recent work, a creator dead under 80 years, an unknown host, no licence", () => {
    const bad: CatalogueBook = {
      ...perrault,
      slug: "x",
      published: 1943,
      creators: [{ name: "A translator", role: "translator", died: 1950 }],
      source: { ...perrault.source, file: "https://example.com/book.html" },
      licence: "",
    };
    const out = checkCatalogue([bad], 2026).join("\n");
    expect(out).toContain("not public domain in the US");
    expect(out).toContain("died less than 80 years ago");
    expect(out).toContain("not on an allowed host");
    expect(out).toContain("licence line missing");
  });

  test("the US cutoff moves each year", () => {
    const b = { ...perrault, published: 1930 };
    expect(checkCatalogue([b], 2026)).toEqual([]);
    expect(checkCatalogue([b], 2025).join()).toContain("not public domain");
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
