// /books (My books) and /library: the shelf rows, and where an old
// /books/<lang>/<slug> link goes (lib/books/legacy-link.ts).

import { describe, expect, test } from "bun:test";
import { legacyBookTarget } from "@/lib/books/legacy-link";
import { shelfBook, shelfByLang, shelfRows, type ShelfRow } from "@/lib/books/shelf";
import { CATALOGUE, bookKey } from "@/lib/books/catalogue";

const perrault = CATALOGUE.find((b) => b.slug === "histoires-ou-contes-du-temps-passé")!;
const key = bookKey(perrault);
const enc = (s: string) => encodeURIComponent(s);

describe("old /books/<lang>/<slug> links", () => {
  test("on the viewer's shelf: stays at /books", () => {
    const t = legacyBookTarget({
      lang: "fr",
      slug: enc(perrault.slug),
      owned: { [key]: "m1" },
      shelf: true,
    });
    expect(t).toEqual({ stay: true });
  });

  test("not on the shelf, signed out, or My books off: 308 target /library/<lang>/<slug>, query kept", () => {
    const href = `/library/fr/${enc(perrault.slug)}`;
    for (const input of [
      { owned: {}, shelf: true },
      { owned: {}, shelf: false },
      { owned: { [key]: "m1" }, shelf: false },
    ])
      expect(legacyBookTarget({ lang: "fr", slug: enc(perrault.slug), ...input })).toEqual({
        stay: false,
        href,
      });
    expect(
      legacyBookTarget({
        lang: "fr",
        slug: perrault.slug,
        search: "?a=1&b=2",
        owned: {},
        shelf: true,
      }),
    ).toEqual({ stay: false, href: `${href}?a=1&b=2` });
  });

  test("a decomposed or raw slug normalises to the stored one; a bad one still goes to /library (its 404)", () => {
    const nfd = perrault.slug.normalize("NFD");
    expect(
      legacyBookTarget({ lang: "fr", slug: enc(nfd), owned: { [key]: "m1" }, shelf: true }),
    ).toEqual({ stay: true });
    const bad = legacyBookTarget({ lang: "fr", slug: "%E0%A4%A", owned: {}, shelf: true });
    expect(bad.stay).toBe(false);
    if (!bad.stay) expect(bad.href.startsWith("/library/fr/")).toBe(true);
  });
});

describe("the shelf (lib/books/shelf.ts)", () => {
  const row = (id: string, source_key: string, at = "2026-11-10T00:00:00.000Z"): ShelfRow => ({
    id,
    title: `T ${id}`,
    source_key,
    updated_at: at,
  });

  test("catalogue books carry their language and author; own files theirs; anything else is not a book", () => {
    const lib = shelfBook(row("a", `preset:${key}`));
    expect(lib).toMatchObject({
      id: "a",
      lang: "fr",
      origin: "library",
      key,
      author: perrault.author,
    });
    const own = shelfBook(row("b", "file:abc"), undefined, () => ({ lang: "de", author: "X" }));
    expect(own).toMatchObject({ id: "b", lang: "de", origin: "file", author: "X" });
    expect(shelfBook(row("c", "file:abc"))).toMatchObject({ lang: "", origin: "file" });
    expect(shelfBook(row("d", "gdoc:xyz"))).toBeNull();
    // A shared catalogue entry not found: still on the shelf, no author.
    expect(shelfBook(row("e", "preset:la/nope"), () => null)).toMatchObject({ lang: "la" });
  });

  test("grouped by language in first-seen order, unknown language last", () => {
    const books = [
      shelfBook(row("1", "file:x"))!,
      shelfBook(row("2", `preset:${key}`))!,
      shelfBook(row("3", "preset:en/alice"), () => null)!,
      shelfBook(row("4", `preset:${key}`))!,
    ];
    expect(shelfByLang(books).map(([l, b]) => [l, b.map((x) => x.id)])).toEqual([
      ["fr", ["2", "4"]],
      ["en", ["3"]],
      ["", ["1"]],
    ]);
  });

  test("one query, scoped to the user, only the shelf's source keys", async () => {
    const seen: { sql: string; args: unknown[] }[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          seen.push({ sql, args });
          return { all: async <T>() => ({ results: [row("a", `preset:${key}`)] as T[] }) };
        },
      }),
    };
    const rows = await shelfRows(db, "u1");
    expect(rows).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toContain("user_id = ?");
    expect(seen[0].args).toEqual(["u1", "preset:%", "file:%"]);
  });
});
