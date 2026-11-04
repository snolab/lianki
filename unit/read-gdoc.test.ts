// Google Docs import (lib/gdoc, app/api/read/gdoc): strict links (no SSRF),
// the export fetched only from Google's hosts, images dropped while
// streaming, the export's class styles kept as marks, comments dropped,
// chapters from headings, and a re-import carrying FSRS state of unchanged lines.
import { describe, expect, it } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { fetchGdocHtml, GdocError, readStripped, titleFromDisposition } from "@/lib/gdoc/fetch";
import { parseGdocHtml } from "@/lib/gdoc/parse";
import { gdocExportUrl, gdocIdOf } from "@/lib/gdoc/url";
import { bookMetaOf, checkBook, parseBookMeta } from "@/lib/read/book";
import { carrySentenceCards, unchangedLines, type D1Batch } from "@/lib/read/reader-store";

const ID = "1JNLojNIQNwn80043PUJ7ZyYXOjtAI4XHJibvtpe7El4";

describe("Google Docs links", () => {
  it("takes the document id from a Docs link", () => {
    expect(gdocIdOf(`https://docs.google.com/document/d/${ID}/edit?tab=t.0`)).toBe(ID);
    expect(gdocIdOf(`https://docs.google.com/document/d/${ID}`)).toBe(ID);
    expect(gdocIdOf(`docs.google.com/document/d/${ID}/edit#heading=h.x`)).toBe(ID);
    expect(gdocIdOf(`https://docs.google.com/document/u/1/d/${ID}/edit`)).toBe(ID);
    expect(gdocIdOf(`  https://docs.google.com/document/d/${ID}/mobilebasic  `)).toBe(ID);
  });

  it("refuses anything else", () => {
    for (const bad of [
      `https://docs.google.com.evil.com/document/d/${ID}/edit`,
      `https://evil.com/docs.google.com/document/d/${ID}`,
      `https://user@docs.google.com/document/d/${ID}`,
      `https://docs.google.com:8443/document/d/${ID}`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com/document/d/e/2PACX-1vQ/pub`,
      `https://drive.google.com/file/d/${ID}/view`,
      `https://docs.google.com/document/d/../../x/edit`,
      `https://docs.google.com/document/d/${ID}%2F..%2F/edit`,
      `javascript:alert(1)`,
      `file:///etc/passwd`,
      "",
      42,
      null,
    ]) {
      expect(gdocIdOf(bad)).toBeNull();
    }
  });

  it("the server fetches only the export URL built from the id", () => {
    expect(gdocExportUrl(ID)).toBe(`https://docs.google.com/document/d/${ID}/export?format=html`);
  });
});

const stream = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });

describe("reading the export", () => {
  it("drops inline images, even split across chunks", async () => {
    const big = "A".repeat(50_000);
    const html = await readStripped(
      stream([`<p>a</p><img alt="x" sr`, `c="data:image/png;base64,${big}`, `${big}"><p>b</p>`]),
    );
    expect(html).toBe('<p>a</p><img alt="x" src=""><p>b</p>');
  });

  it("caps the text left and the bytes downloaded", async () => {
    const limits = { maxHtmlChars: 100, maxRawBytes: 1000, maxRedirects: 4, timeoutMs: 1000 };
    await expect(readStripped(stream(["x".repeat(200)]), limits)).rejects.toThrow("too-large");
    await expect(
      readStripped(stream([`<img src="data:${"A".repeat(2000)}">`]), limits),
    ).rejects.toThrow("too-large");
  });

  it("the title is the download name", () => {
    expect(
      titleFromDisposition(
        `attachment; filename="Plain.html"; filename*=UTF-8''Caf%C3%A9%20%E2%80%94%20Notes.html`,
      ),
    ).toBe("Café — Notes");
    expect(titleFromDisposition(`attachment; filename="Plain.html"`)).toBe("Plain");
    expect(titleFromDisposition(null)).toBeNull();
  });
});

type Hop = { status: number; headers?: Record<string, string>; body?: string };
function fakeFetch(hops: Hop[]) {
  const seen: string[] = [];
  const f = (async (url: string) => {
    seen.push(String(url));
    const h = hops.shift();
    if (!h) throw new Error("no more hops");
    return new Response(h.body ?? "", { status: h.status, headers: h.headers });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("fetching", () => {
  const ok = {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="T.html"`,
    },
    body: "<p>Hello.</p>",
  };

  it("follows a redirect only to Google's export hosts", async () => {
    const { f, seen } = fakeFetch([
      { status: 307, headers: { location: "https://doc-0s-docs.googleusercontent.com/x" } },
      ok,
    ]);
    expect(await fetchGdocHtml(ID, f)).toEqual({ html: "<p>Hello.</p>", title: "T" });
    expect(seen).toEqual([gdocExportUrl(ID), "https://doc-0s-docs.googleusercontent.com/x"]);

    const evil = fakeFetch([{ status: 302, headers: { location: "http://169.254.169.254/" } }]);
    await expect(fetchGdocHtml(ID, evil.f)).rejects.toThrow("fetch-failed");
    expect(evil.seen.length).toBe(1);
  });

  it("a sign-in redirect or 401/403 means the doc is not shared by link", async () => {
    const codeOf = async (hops: Hop[]) =>
      fetchGdocHtml(ID, fakeFetch(hops).f).then(
        () => "ok",
        (e: GdocError) => e.code,
      );
    expect(
      await codeOf([
        {
          status: 302,
          headers: { location: "https://accounts.google.com/ServiceLogin?continue=x" },
        },
      ]),
    ).toBe("not-shared");
    expect(await codeOf([{ status: 401 }])).toBe("not-shared");
    expect(await codeOf([{ status: 403 }])).toBe("not-shared");
    expect(await codeOf([{ status: 404 }])).toBe("not-found");
    expect(
      await codeOf([
        {
          status: 200,
          headers: { "content-type": "text/html" },
          body: '<a href="https://accounts.google.com/ServiceLogin?x">Sign in</a>',
        },
      ]),
    ).toBe("not-shared");
    expect(await codeOf([{ status: 200, headers: { "content-type": "application/pdf" } }])).toBe(
      "fetch-failed",
    );
  });
});

const EXPORT = `<html><head><meta content="text/html; charset=UTF-8" http-equiv="content-type"><style type="text/css">.c1{font-weight:700}.c2{font-style:italic}.c3{vertical-align:super}.c9{font-weight:400}</style><title>Ignored</title></head><body class="c0 doc-content">
<p class="c4 title" id="h.t"><span class="c9">My Notes</span></p>
<h1 id="h.a"><span>Part one</span></h1>
<p><span class="c9">It was a </span><span class="c1">bold</span><span class="c9"> and </span><span class="c1 c2">very</span><span> night.</span><sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup></p>
<p><span>Line one</span><br><span>line two</span><sup><a href="#ftnt1" id="ftnt_ref1">[1]</a></sup></p>
<p><span></span></p>
<h2><span>A section</span></h2>
<p><span>E = mc</span><span class="c3">2</span></p>
<h1><span>Part two</span></h1>
<p><span>The end.</span></p>
<div><p><a href="#ftnt_ref1" id="ftnt1">[1]</a><span> A footnote.</span></p></div>
<div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>A comment from a reviewer</span></p></div>
</body></html>`;

describe("export → book", () => {
  const b = parseGdocHtml(EXPORT, "My Notes");

  it("paragraphs as written; comments dropped, footnote text kept", () => {
    expect(b.lines).toEqual([
      "My Notes",
      "Part one",
      "It was a bold and very night.",
      "Line one",
      "line two",
      "A section",
      "E = mc2",
      "Part two",
      "The end.",
      "A footnote.",
    ]);
    expect(b.breaks).toEqual([4]);
  });

  it("class styles become marks", () => {
    expect(b.marks).toContainEqual([2, 9, 13, "strong"]);
    expect(b.marks).toContainEqual([2, 18, 22, "strong"]);
    expect(b.marks).toContainEqual([2, 18, 22, "em"]);
    expect(b.marks).toContainEqual([6, 6, 7, "sup"]);
    expect(b.marks?.some(([l]) => l === 0)).toBe(false);
  });

  it("headings kept; chapters at the top level used more than once", () => {
    expect(b.headings).toEqual([0, 1, 5, 7]);
    expect(b.chapters).toEqual([
      { title: "My Notes", start: 0 },
      { title: "Part one", start: 1 },
      { title: "Part two", start: 7 },
    ]);
  });

  it("passes the server's book check; meta keeps the source", () => {
    const c = checkBook(b);
    expect(c.ok).toBe(true);
    const url = `https://docs.google.com/document/d/${ID}/edit`;
    const meta = bookMetaOf(c.ok ? c.book : b, { source: "gdoc", sourceUrl: url });
    const back = parseBookMeta(JSON.stringify(meta));
    expect(back?.source).toBe("gdoc");
    expect(back?.sourceUrl).toBe(url);
    // A forged link in stored meta is dropped.
    const forged = parseBookMeta(JSON.stringify({ ...meta, sourceUrl: "https://evil.example/" }));
    expect(forged?.sourceUrl).toBeUndefined();
  });

  it("an empty doc has no text", () => {
    expect(() => parseGdocHtml("<html><body><p><span></span></p></body></html>", null)).toThrow(
      "no-text",
    );
  });

  it("without a download name the title comes from the export", () => {
    expect(parseGdocHtml(EXPORT, null).title).toBe("Ignored");
  });
});

describe("re-import", () => {
  it("matches unchanged lines in order", () => {
    expect(unchangedLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"])).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
    expect(unchangedLines(["a", "a", "b"], ["b", "a", "a"])).toEqual([[2, 0]]);
    expect(unchangedLines(["p", "q"], ["new", "p", "q"])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("carries sentence cards of unchanged lines to the new ids, for that user only", async () => {
    const d1 = createTestD1(testSchema());
    const db = d1 as unknown as D1Batch;
    const OLD = "aaaaaaaaaaaaaaaa";
    const NEW = "bbbbbbbbbbbbbbbb";
    const ins = (user: string, line: number, idx: number) =>
      db
        .prepare(
          `INSERT INTO read_sentence_cards
             (user_id, sid, book_hash, line, idx, text_key, card, due, last_rating, rev, updated_at)
           VALUES (?, ?, ?, ?, ?, 'k', '{"state":2}', '2026-11-05', 3, 'r1', '2026-11-04')`,
        )
        .bind(user, `${OLD}:${line}.${idx}`, OLD, line, idx)
        .run();
    await ins("u", 1, 0);
    await ins("u", 1, 1);
    await ins("u", 2, 0);
    await ins("other", 1, 0);
    // Old line 1 is new line 2; old line 2 changed.
    await carrySentenceCards(db, "u", OLD, NEW, [
      [0, 1],
      [1, 2],
    ]);
    const { results } = await db
      .prepare(
        "SELECT user_id, sid, line, idx, card FROM read_sentence_cards WHERE book_hash = ? ORDER BY user_id, sid",
      )
      .bind(NEW)
      .all<{ user_id: string; sid: string; line: number; idx: number; card: string }>();
    expect(results).toEqual([
      { user_id: "u", sid: `${NEW}:2.0`, line: 2, idx: 0, card: '{"state":2}' },
      { user_id: "u", sid: `${NEW}:2.1`, line: 2, idx: 1, card: '{"state":2}' },
    ]);
    // The old rows stay.
    const old = await db
      .prepare("SELECT COUNT(*) AS c FROM read_sentence_cards WHERE book_hash = ?")
      .bind(OLD)
      .first<{ c: number }>();
    expect(old?.c).toBe(4);
  });
});
