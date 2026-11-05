// /books 「找更多书」: the library guide as data, the hosts it adds to the
// paste box (Standard Ebooks; Wikisource in more languages), and the /books
// table of contents. All pages here are small synthetic fixtures.

import { describe, expect, test } from "bun:test";
import {
  CATALOGUE,
  SOURCE_HOSTS,
  catalogueByLang,
  type CatalogueBook,
} from "@/lib/books/catalogue";
import {
  LIBRARIES,
  STANDARD_EBOOKS_HOST,
  WIKISOURCE,
  checkLibraries,
  librariesByLang,
  type Library,
} from "@/lib/books/libraries";
import {
  WIKISOURCE_SITES,
  fetchMeta,
  judge,
  linkKey,
  linkPage,
  parseBookLink,
  readFacts,
  standardEbooksFacts,
  wikisourceFacts,
} from "@/lib/books/resolve";
import {
  cleanStandardEbooks,
  dataUriStripper,
  fetchSourceFile,
  isContentsPage,
  parseSource,
} from "@/lib/books/source";
import { searchStandardEbooks } from "@/lib/books/search";
import {
  FIND_SECTION_ID,
  LIBRARIES_SECTION_ID,
  booksToc,
  langSectionId,
  levelAnchorId,
  levelAnchors,
} from "@/lib/books/toc";

const YEAR = 2026;

/** Synthetic English Wikipedia: article (or redirect) → its Wikidata item. */
const WIKI: Record<string, { to?: string; qid: string }> = {
  "A Little Tale": { to: "A Little Tale (novel)", qid: "Q10" },
  "Ada Writer": { qid: "Q11" },
  "Bob Painter": { qid: "Q12" },
};

/** The Wikipedia pageprops API over WIKI, for any set of titles. */
function wikipedia(url: string): string | undefined {
  const u = new URL(url);
  if (u.hostname !== "en.wikipedia.org") return undefined;
  const titles = (u.searchParams.get("titles") ?? "").split("|");
  const redirects = titles.filter((t) => WIKI[t]?.to).map((t) => ({ from: t, to: WIKI[t].to! }));
  const pages = titles
    .filter((t) => WIKI[t])
    .map((t) => ({ title: WIKI[t].to ?? t, pageprops: { wikibase_item: WIKI[t].qid } }));
  return JSON.stringify({ query: { pages, redirects } });
}

/** A fetch answering from URL → body, recording calls; anything else 404s. */
function hosts(routes: Record<string, string>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url] ?? wikipedia(url);
    if (body === undefined) return new Response("no", { status: 404 });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": body.startsWith("{")
          ? "application/json; charset=utf-8"
          : "application/xhtml+xml; charset=utf-8",
      },
    });
  }) as typeof fetch;
  return { f, calls, get: (u: string) => fetchMeta(u, f) };
}

describe("the library guide (data)", () => {
  test("every entry has a url, a licence line and a support level; guide-only says why", () => {
    expect(checkLibraries(LIBRARIES)).toEqual([]);
    for (const l of LIBRARIES) {
      expect(l.url.startsWith("https://")).toBe(true);
      expect(l.licence.length).toBeGreaterThan(20);
      expect(["paste", "guide"]).toContain(l.support);
      if (l.support === "guide") expect(["no-reader", "terms", "no-facts"]).toContain(l.why!);
    }
  });

  test("the check catches a missing licence, a guide without a reason, a paste without a sample", () => {
    const bad: Library[] = [
      {
        id: "a",
        name: "A",
        url: "http://a.example/",
        lang: "en",
        offers: [],
        licence: "",
        support: "paste",
      },
      {
        id: "a",
        name: "B",
        url: "https://b.example/",
        lang: "xx-?",
        offers: ["scans"],
        licence: "x".repeat(30),
        support: "guide",
      },
    ];
    const problems = checkLibraries(bad).join("\n");
    for (const p of [
      "url must be https",
      "offers missing",
      "licence line missing",
      "paste needs a sample",
      "duplicate id",
      "bad lang",
      "guide needs a reason",
    ])
      expect(problems).toContain(p);
  });

  test("a library marked paste really pastes: its sample parses, on a host the importer fetches", () => {
    for (const l of LIBRARIES.filter((x) => x.support === "paste")) {
      const link = parseBookLink(l.sample!);
      expect(link).not.toBeNull();
      expect(SOURCE_HOSTS).toContain(new URL(linkPage(link!)).hostname);
    }
  });

  test("a guide-only library is not a host we fetch, and every Wikisource we read is listed", () => {
    for (const l of LIBRARIES.filter((x) => x.support === "guide"))
      expect(SOURCE_HOSTS).not.toContain(new URL(l.url).hostname);
    for (const host of Object.keys(WIKISOURCE)) {
      expect(LIBRARIES.some((l) => l.support === "paste" && new URL(l.url).hostname === host)).toBe(
        true,
      );
      expect(SOURCE_HOSTS).toContain(host);
    }
    expect(SOURCE_HOSTS).toContain(STANDARD_EBOOKS_HOST);
  });

  test("libraries whose terms forbid our use are guide-only, never pasted", () => {
    const byId = new Map(LIBRARIES.map((l) => [l.id, l]));
    for (const id of [
      "ctext",
      "gallica",
      "projekt-gutenberg-de",
      "liberliber",
      "cervantes-virtual",
    ])
      expect(byId.get(id)).toMatchObject({ support: "guide", why: "terms" });
    // Excluded on purpose (docs/books-plan.md): Australian or mixed copyright bases.
    for (const url of ["gutenberg.net.au", "lib.ru"])
      expect(LIBRARIES.some((l) => l.url.includes(url))).toBe(false);
  });

  test("grouped by language in first-appearance order, many languages first", () => {
    const groups = librariesByLang();
    expect(groups[0][0]).toBe("mul");
    expect(groups.flatMap(([, l]) => l)).toHaveLength(LIBRARIES.length);
    // A language's Wikisource joins that language's group.
    const fr = groups.find(([lang]) => lang === "fr")![1].map((l) => l.id);
    expect(fr).toEqual(["gallica", "wikisource-fr"]);
  });
});

describe("links: Standard Ebooks and more Wikisource sites", () => {
  test("a Standard Ebooks page, any file under it, an edition with a translator or illustrator", () => {
    for (const [url, path] of [
      [
        "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice",
        "jane-austen/pride-and-prejudice",
      ],
      [
        "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/single-page",
        "jane-austen/pride-and-prejudice",
      ],
      [
        "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/x.epub",
        "jane-austen/pride-and-prejudice",
      ],
      [
        "https://standardebooks.org/ebooks/lewis-carroll/alices-adventures-in-wonderland/john-tenniel/",
        "lewis-carroll/alices-adventures-in-wonderland/john-tenniel",
      ],
      [
        "https://standardebooks.org/ebooks/leo-tolstoy/the-cossacks/louise-maude_aylmer-maude/text/single-page",
        "leo-tolstoy/the-cossacks/louise-maude_aylmer-maude",
      ],
    ]) {
      const l = parseBookLink(url);
      expect(l).toEqual({ host: "standardebooks", path });
      expect(linkKey(l!)).toBe(`standardebooks:${path}`);
    }
    for (const bad of [
      "https://standardebooks.org/ebooks/jane-austen",
      "https://standardebooks.org/ebooks?query=austen",
      "https://standardebooks.org/ebooks/Jane/x",
      "https://standardebooks.org/ebooks/a/b/c/d",
      "https://standardebooks.org.evil.com/ebooks/a/b",
    ])
      expect(parseBookLink(bad)).toBeNull();
  });

  test("every Wikisource in the data is read the same way, its language from the data", () => {
    expect(Object.keys(WIKISOURCE_SITES).length).toBeGreaterThanOrEqual(15);
    for (const [host, lang] of Object.entries(WIKISOURCE_SITES)) {
      expect(lang).toBe(WIKISOURCE[host].lang);
      expect(parseBookLink(`https://${host}/wiki/Sample_Title`)).toEqual({
        host: "wikisource",
        site: host,
        title: "Sample Title",
      });
      const mobile = host.replace(".wikisource", ".m.wikisource");
      expect(parseBookLink(`https://${mobile}/wiki/X`)).toMatchObject({ site: host });
    }
  });
});

// ── Synthetic Wikipedia / Wikidata ──────────────────────────────────────────

const wd = (ids: string) =>
  `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims%7Clabels&ids=${ids}`;
const time = (y: number) => ({
  mainsnak: { datavalue: { value: { time: `+${y}-01-01T00:00:00Z`, precision: 9 } } },
});
const item = (id: string) => ({ mainsnak: { datavalue: { value: { id } } } });
const enwiki = (titles: string[]) =>
  `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=${titles.map(encodeURIComponent).join("%7C")}`;

/** A Standard Ebooks ebook page reduced to what the reader looks at. */
function sePage(opts: {
  workWiki?: string;
  authors: { name: string; wiki?: string }[];
  lines?: string[];
  placeholder?: boolean;
}) {
  const same = (u?: string) => (u ? `<meta property="schema:sameAs" content="${u}"/>` : "");
  return `<?xml version="1.0" encoding="utf-8"?><html><body><main>
<article class="ebook${opts.placeholder ? " ebook-placeholder" : ""}" typeof="schema:Book" about="/ebooks/x/y">
${same(opts.workWiki)}
<header><hgroup><h1 property="schema:name">A Little Tale</h1>
${opts.authors
  .map(
    (a) =>
      `<p><a property="schema:author" typeof="schema:Person" href="/ebooks/x"><span property="schema:name">${a.name}</span><meta property="schema:sameAs" content="https://id.loc.gov/authorities/names/n1.html"/>${same(a.wiki)}</a></p>`,
  )
  .join("")}
</hgroup></header>
<aside id="reading-ease"><p>12,000 words with a reading ease of 80</p>${(opts.lines ?? []).map((l) => `<p>${l}</p>`).join("")}</aside>
<section id="read-free" property="schema:workExample" typeof="schema:Book"><meta property="schema:inLanguage" content="en-GB"/></section>
</article></main></body></html>`;
}

const SE_LINK = { host: "standardebooks" as const, path: "ada-writer/a-little-tale" };

describe("Standard Ebooks: the page, Wikipedia → Wikidata", () => {
  const entities = {
    Q10: { id: "Q10", claims: { P50: [item("Q11")], P577: [time(1902)], P495: [item("Q4")] } },
    Q11: { id: "Q11", labels: { en: { value: "Ada Writer" } }, claims: { P570: [time(1910)] } },
    Q12: { id: "Q12", labels: { en: { value: "Bob Painter" } }, claims: { P570: [time(1920)] } },
    Q4: { id: "Q4", claims: { P297: [{ mainsnak: { datavalue: { value: "GB" } } }] } },
  };
  // Wikidata answers for any set of these ids the reader asks for.
  const ask = (ids: string[]) => [
    wd(ids.join("%7C")),
    JSON.stringify({
      entities: Object.fromEntries(ids.map((i) => [i, entities[i as keyof typeof entities]])),
    }),
  ];
  const routes = (extra: Record<string, string> = {}) => ({
    ...Object.fromEntries([ask(["Q10"]), ask(["Q11", "Q12", "Q4"]), ask(["Q11", "Q4"])]),
    ...extra,
  });

  test("an illustrated edition: the work's year and country, every person's death year", async () => {
    const page = sePage({
      workWiki: "https://en.wikipedia.org/wiki/A_Little_Tale",
      authors: [{ name: "Ada Writer", wiki: "https://en.wikipedia.org/wiki/Ada_Writer" }],
      lines: [
        'Illustrated by <a href="https://en.wikipedia.org/wiki/Bob_Painter">Bob Painter</a>.',
      ],
    });
    const { get } = hosts(routes());
    const facts = (await standardEbooksFacts(SE_LINK, page, get))!;
    expect(facts).toMatchObject({
      title: "A Little Tale",
      author: "Ada Writer",
      lang: "en",
      firstPublicationYear: 1902,
      workCountry: "GB",
      translation: false,
    });
    expect(facts.creators).toEqual([
      { name: "Ada Writer", role: "author", deathYear: 1910 },
      { name: "Bob Painter", role: "illustrator", deathYear: 1920 },
    ]);
    expect(facts.source).toMatchObject({
      page: "https://standardebooks.org/ebooks/ada-writer/a-little-tale",
      file: "https://standardebooks.org/ebooks/ada-writer/a-little-tale/text/single-page",
      format: "standardebooks-xhtml",
    });
    expect(facts.licence).toContain("CC0");
    const v = judge(facts, "JP", YEAR);
    expect(v.ok).toBe(true);
  });

  test("readFacts fetches the ebook page, then Wikipedia and Wikidata only", async () => {
    const page = sePage({
      workWiki: "https://en.wikipedia.org/wiki/A_Little_Tale",
      authors: [{ name: "Ada Writer", wiki: "https://en.wikipedia.org/wiki/Ada_Writer" }],
      lines: [
        'Illustrated by <a href="https://en.wikipedia.org/wiki/Bob_Painter">Bob Painter</a>.',
      ],
    });
    const { get, calls } = hosts(routes({ [linkPage(SE_LINK)]: page }));
    expect(await readFacts(SE_LINK, get)).not.toBeNull();
    expect(calls.map((u) => new URL(u).hostname)).toEqual([
      "standardebooks.org",
      "en.wikipedia.org",
      "www.wikidata.org",
      "www.wikidata.org",
    ]);
  });

  test("a translation, an illustrator without an article, an unknown role, a placeholder", async () => {
    const { get } = hosts(routes());
    const base = {
      workWiki: "https://en.wikipedia.org/wiki/A_Little_Tale",
      authors: [{ name: "Ada Writer", wiki: "https://en.wikipedia.org/wiki/Ada_Writer" }],
    };
    const tr = (await standardEbooksFacts(
      SE_LINK,
      sePage({ ...base, lines: ["Translated by Carl Someone."] }),
      get,
    ))!;
    expect(tr.translation).toBe(true);
    expect(judge(tr, "JP", YEAR)).toMatchObject({ ok: false, reason: "translation" });

    const noWiki = (await standardEbooksFacts(
      SE_LINK,
      sePage({ ...base, lines: ["Illustrated by Dora Unknown."] }),
      get,
    ))!;
    expect(noWiki.creators).toContainEqual({
      name: "Dora Unknown",
      role: "illustrator",
      deathYear: null,
    });
    expect(judge(noWiki, "JP", YEAR)).toMatchObject({
      ok: false,
      reason: "missing-death-year",
      detail: "Dora Unknown",
    });

    const odd = (await standardEbooksFacts(
      SE_LINK,
      sePage({
        ...base,
        lines: ['Narrated by <a href="https://en.wikipedia.org/wiki/Bob_Painter">Bob</a>.'],
      }),
      get,
    ))!;
    expect(judge(odd, "JP", YEAR)).toMatchObject({ ok: false, reason: "unknown-role" });

    expect(
      await standardEbooksFacts(SE_LINK, sePage({ ...base, placeholder: true }), get),
    ).toBeNull();
  });

  test("no work article on the page: no first publication, so it cannot be confirmed", async () => {
    const { get } = hosts({
      [enwiki(["Ada Writer"])]: JSON.stringify({
        query: { pages: [{ title: "Ada Writer", pageprops: { wikibase_item: "Q11" } }] },
      }),
      [wd("Q11")]: JSON.stringify({
        entities: { Q11: { id: "Q11", claims: { P570: [time(1910)] } } },
      }),
    });
    const facts = (await standardEbooksFacts(
      SE_LINK,
      sePage({
        authors: [{ name: "Ada Writer", wiki: "https://en.wikipedia.org/wiki/Ada_Writer" }],
      }),
      get,
    ))!;
    expect(facts.firstPublicationYear).toBeNull();
    expect(judge(facts, "JP", YEAR)).toMatchObject({
      ok: false,
      reason: "missing-first-publication",
    });
  });

  test("the catalogue search: produced ebooks only, placeholders left out", async () => {
    const li = (path: string, title: string, author: string, placeholder = false) =>
      `<li typeof="schema:Book" about="/ebooks/${path}"><div class="thumbnail-container">${placeholder ? '<div class="placeholder-cover"></div>' : "<img/>"}</div><p><a href="/ebooks/${path}" property="schema:url"><span property="schema:name">${title}</span></a></p><p class="author" typeof="schema:Person" property="schema:author"><a href="/x" property="schema:url"><span property="schema:name">${author}</span></a></p></li>`;
    const { get } = hosts({
      "https://standardebooks.org/ebooks?query=tale": `<html><body><ol>${li("ada-writer/a-little-tale", "A Little Tale", "Ada Writer")}${li("ada-writer/unmade", "Unmade", "Ada Writer", true)}</ol></body></html>`,
    });
    expect(await searchStandardEbooks("tale", get)).toEqual([
      {
        url: "https://standardebooks.org/ebooks/ada-writer/a-little-tale",
        title: "A Little Tale",
        author: "Ada Writer",
        lang: "en",
        site: "Standard Ebooks",
      },
    ]);
  });
});

describe("Standard Ebooks: the file", () => {
  const FILE = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>A Little Tale</title><style><![CDATA[ p { margin: 0 } ]]></style></head>
<body><header><nav><ul><li><a href="/">Standard Ebooks</a></li></ul></nav></header><main>
<section id="titlepage" epub:type="frontmatter titlepage"><h1>A Little Tale</h1><p>By Ada Writer.</p></section>
<nav id="toc" epub:type="toc"><h2>Table of Contents</h2><ol><li><a href="#chapter-1">I</a></li></ol></nav>
<section id="imprint" epub:type="frontmatter imprint"><h2>Imprint</h2><p>This ebook is the product of many hours.</p></section>
${[1, 2, 3]
  .map(
    (n) =>
      `<section id="chapter-${n}" epub:type="bodymatter chapter"><h2 epub:type="ordinal z3998:roman">${"I".repeat(n)}</h2><p>Chapter ${n} begins<a href="#note-${n}" id="noteref-${n}" epub:type="noteref">${n}</a> here.</p><img alt="" src="data:image/png;base64,${"A".repeat(200)}"/><blockquote><footer>Signed, Ada</footer></blockquote></section>`,
  )
  .join("\n")}
<section id="endnotes" epub:type="backmatter endnotes"><h2>Endnotes</h2><p>A note.</p></section>
<section id="colophon" epub:type="backmatter colophon"><h2>Colophon</h2><p>Produced by volunteers.</p></section>
<section id="uncopyright" epub:type="backmatter copyright-page"><h2>Uncopyright</h2><p>CC0 dedication.</p></section>
</main></body></html>`;

  const entry: CatalogueBook = {
    slug: "a-little-tale",
    title: "A Little Tale",
    author: "Ada Writer",
    lang: "en",
    level: "",
    workCountry: "GB",
    firstPublicationYear: 1902,
    creators: [{ name: "Ada Writer", role: "author", deathYear: 1910 }],
    source: {
      page: "https://standardebooks.org/ebooks/ada-writer/a-little-tale",
      file: "https://standardebooks.org/ebooks/ada-writer/a-little-tale/text/single-page",
      format: "standardebooks-xhtml",
      name: "Standard Ebooks",
    },
    licence: "Public domain in the US; CC0.",
    attribution: "Standard Ebooks (standardebooks.org)",
  };

  test("only the chapters: no site nav, title page, imprint, contents, notes, colophon or styles", () => {
    const clean = cleanStandardEbooks(FILE);
    for (const gone of [
      "Standard Ebooks</a>",
      "By Ada Writer",
      "Imprint",
      "Table of Contents",
      "Endnotes",
      "Colophon",
      "Uncopyright",
      "margin: 0",
      "noteref",
    ])
      expect(clean).not.toContain(gone);
    expect(clean).toContain("Signed, Ada");
    const book = parseSource(entry, FILE);
    expect(book.chapters.map((c) => c.title)).toEqual(["I", "II", "III"]);
    expect(book.lines).toContain("Chapter 1 begins here.");
  });

  test("inline images are dropped as the file streams: a file far over the cap still fits", async () => {
    const big = FILE.replace(/A{200}/g, "B".repeat(40_000));
    expect(big.length).toBeGreaterThan(100_000);
    const f = (async () => {
      const bytes = new TextEncoder().encode(big);
      // Small chunks, so a data: URI starts in one and ends in another.
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 777) c.enqueue(bytes.subarray(i, i + 777));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/xhtml+xml" },
      });
    }) as unknown as typeof fetch;
    const html = await fetchSourceFile(entry, f, {
      maxBytes: 20_000,
      maxStreamBytes: 1_000_000,
      maxRedirects: 3,
      timeoutMs: 5000,
    });
    expect(html).not.toContain("BBBB");
    expect(html).toContain('src="data:"');
    expect(parseSource(entry, html).chapters).toHaveLength(3);
    // Without the stream allowance, the same file is too large.
    await expect(
      fetchSourceFile(entry, f, {
        maxBytes: 20_000,
        maxStreamBytes: 50_000,
        maxRedirects: 3,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("too-large");
  });

  test("the stripper keeps text that only looks like data: (not an attribute value)", () => {
    const strip = dataUriStripper();
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    const text =
      '<p>He said "data: none" and left.</p><img src=\'data:x;base64,QUJD\'/><a href="data">x</a>';
    const out = [...text].map((ch) => dec(strip(enc(ch)))).join("");
    expect(out).toBe(
      '<p>He said "data: none" and left.</p><img src=\'data:\'/><a href="data">x</a>',
    );
  });
});

describe("Wikisource in more languages", () => {
  test("an edition's own translators only: a work item listing other editions' translators is not a translation", async () => {
    const { get } = hosts({
      "https://fr.wikisource.org/w/api.php?action=query&format=json&formatversion=2&prop=pageprops%7Crevisions&rvprop=ids&redirects=1&titles=Le%20Conte":
        JSON.stringify({
          query: {
            pages: [
              { title: "Le Conte", pageprops: { wikibase_item: "Q1" }, revisions: [{ revid: 7 }] },
            ],
          },
        }),
      [wd("Q1")]: JSON.stringify({
        entities: { Q1: { id: "Q1", claims: { P629: [item("Q2")], P407: [item("Q50")] } } },
      }),
      [wd("Q2")]: JSON.stringify({
        entities: {
          Q2: {
            id: "Q2",
            claims: {
              P50: [item("Q3")],
              P655: [item("Q9")],
              P577: [time(1880)],
              P495: [item("Q4")],
              P407: [item("Q50")],
            },
          },
        },
      }),
      [wd("Q3%7CQ4")]: JSON.stringify({
        entities: {
          Q3: {
            id: "Q3",
            labels: { fr: { value: "Ada Écrivain" } },
            claims: { P570: [time(1900)] },
          },
          Q4: { id: "Q4", claims: { P297: [{ mainsnak: { datavalue: { value: "FR" } } }] } },
        },
      }),
    });
    const facts = (await wikisourceFacts(
      { host: "wikisource", site: "fr.wikisource.org", title: "Le Conte" },
      get,
    ))!;
    expect(facts).toMatchObject({
      lang: "fr",
      author: "Ada Écrivain",
      translation: false,
      workCountry: "FR",
    });
    expect(facts.creators).toEqual([{ name: "Ada Écrivain", role: "author", deathYear: 1900 }]);
    expect(judge(facts, "FR", YEAR).ok).toBe(true);
  });

  test("an edition in another language than its work is a translation", async () => {
    const { get } = hosts({
      "https://en.wikisource.org/w/api.php?action=query&format=json&formatversion=2&prop=pageprops%7Crevisions&rvprop=ids&redirects=1&titles=The%20Tale":
        JSON.stringify({
          query: {
            pages: [
              { title: "The Tale", pageprops: { wikibase_item: "Q1" }, revisions: [{ revid: 7 }] },
            ],
          },
        }),
      [wd("Q1")]: JSON.stringify({
        entities: { Q1: { id: "Q1", claims: { P629: [item("Q2")], P407: [item("Q51")] } } },
      }),
      [wd("Q2")]: JSON.stringify({
        entities: { Q2: { id: "Q2", claims: { P50: [item("Q3")], P407: [item("Q50")] } } },
      }),
      [wd("Q3")]: JSON.stringify({
        entities: { Q3: { id: "Q3", claims: { P570: [time(1900)] } } },
      }),
    });
    const facts = (await wikisourceFacts(
      { host: "wikisource", site: "en.wikisource.org", title: "The Tale" },
      get,
    ))!;
    expect(facts.translation).toBe(true);
  });

  test("a contents page (its text is in sub-pages) is not a book", () => {
    const toc = `<html><body><section><p>Préface</p><ul>${Array.from({ length: 20 }, (_, i) => `<li><a rel="mw:WikiLink" href="./Les_Fleurs/Poème_${i}">Poème numéro ${i}</a></li>`).join("")}</ul></section></body></html>`;
    expect(isContentsPage(toc)).toBe(true);
    const text = `<html><body><p>${"Une longue phrase du texte. ".repeat(40)}</p><p><a href="./Les_Fleurs/Suite">Suite</a></p></body></html>`;
    expect(isContentsPage(text)).toBe(false);
  });
});

describe("the /books table of contents", () => {
  const groups = catalogueByLang(CATALOGUE).map(
    ([lang, books]) => [lang, lang.toUpperCase(), books] as [string, string, CatalogueBook[]],
  );

  test("every language section shown has an entry, with a stable id from its code", () => {
    const toc = booksToc(groups, null);
    expect(toc.map((i) => i.id)).toEqual(groups.map(([lang]) => langSectionId(lang)));
    expect(new Set(toc.map((i) => i.id)).size).toBe(toc.length);
    expect(langSectionId("zh-Hant")).toBe("books-zh-hant");
    expect(levelAnchorId("fr", "A2–B1")).toBe("books-fr-a2-b1");
  });

  test("level sub-items point at an anchor the list sets, on the first book of that level", () => {
    for (const item of booksToc(groups, null)) {
      const [lang, , books] = groups.find(([l]) => langSectionId(l) === item.id)!;
      const anchors = [...levelAnchors(lang, books).values()];
      for (const c of item.children ?? []) expect(anchors).toContain(c.id);
      if (item.children) expect(item.children.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("the filter: a group with no match has no entry; the find section and its libraries come last", () => {
    const filtered = groups.map(
      ([l, n, b], i) => [l, n, i === 0 ? [] : b] as [string, string, CatalogueBook[]],
    );
    const toc = booksToc(filtered, { title: "Find more books", libraries: "Libraries" });
    expect(toc.map((i) => i.id)).not.toContain(langSectionId(groups[0][0]));
    expect(toc.at(-1)).toEqual({
      id: FIND_SECTION_ID,
      label: "Find more books",
      children: [{ id: LIBRARIES_SECTION_ID, label: "Libraries" }],
    });
    expect(booksToc([], null)).toEqual([]);
  });

  test("every anchor the TOC names is set by the page code", async () => {
    const src = await Bun.file("app/(app)/books/BooksBrowser.tsx").text();
    expect(src).toContain("id={langSectionId(lang)}");
    expect(src).toContain("id={anchors.get(i)}");
    const finder = await Bun.file("app/(app)/books/BookFinder.tsx").text();
    expect(finder).toContain("id={FIND_SECTION_ID}");
    expect(finder).toContain("id={LIBRARIES_SECTION_ID}");
  });
});
