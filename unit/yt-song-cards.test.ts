/**
 * A card made from a YouTube song's line keeps that line's clip on its entry
 * (docs/youtube-song-examples.md, M2), served to /words with its example (M3).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { WordEntriesD1Repo } from "@/lib/repos/wordEntriesD1";
import { addGradedEntries, makeCards, scopeSession, type BookCtx } from "@/lib/read/book-word-list";
import { bookMetaOf } from "@/lib/read/book";
import { parseCardClip, songClipFinder } from "@/lib/yt-songs/card-clip";
import { songBook } from "@/lib/yt-songs/song";
import { examplesOf, withPickedExample } from "@/lib/words/example-pick";

const V = "dQw4w9WgXcQ";
const LINES = [
  { t0: 1_000, t1: 4_000, text: "Le chien court dans la rue" },
  { t0: 4_000, t1: 8_000, text: "Le loup dort sous la lune" },
];
const song = (offsetMs = 0) => {
  const { book, yt } = songBook(V, "Chanson", LINES, offsetMs);
  return { meta: bookMetaOf(book, { source: "youtube", yt }), lines: book.lines };
};

describe("songClipFinder", () => {
  test("an example's line gives its clip, offset applied", () => {
    const { meta, lines } = song(500);
    const find = songClipFinder(meta, lines)!;
    expect(parseCardClip(find("Le loup dort sous la lune"))).toEqual({
      v: V,
      t0: 4_500,
      t1: 8_500,
    });
    // A sentence inside the line, other spacing: the same line.
    expect(parseCardClip(find("  chien court  dans"))).toEqual({ v: V, t0: 1_500, t1: 4_500 });
    expect(find("not in the song")).toBeNull();
    expect(find("   ")).toBeNull();
  });
  test("not a song, or clips that no longer match the lines: no finder", () => {
    const { meta, lines } = song();
    expect(songClipFinder({ ...meta, source: "epub" }, lines)).toBeUndefined();
    expect(songClipFinder(meta, [...lines, "extra"])).toBeUndefined();
    expect(songClipFinder(null, lines)).toBeUndefined();
  });
});

describe("parseCardClip", () => {
  test("only a sane clip", () => {
    expect(parseCardClip('{"v":"dQw4w9WgXcQ","t0":1,"t2":2}')).toBeNull();
    expect(parseCardClip({ v: V, t0: 5, t1: 5 })).toBeNull();
    expect(parseCardClip({ v: "x", t0: 0, t1: 5 })).toBeNull();
    expect(parseCardClip("not json")).toBeNull();
    expect(parseCardClip(null)).toBeNull();
    expect(parseCardClip({ v: V, t0: 0, t1: 5 })).toEqual({ v: V, t0: 0, t1: 5 });
  });
});

describe("a song's cards keep their clip (D1)", () => {
  const EMAIL = "me@example.com";
  const NOW = new Date("2026-11-09T12:00:00Z");
  let d1: TestD1Database;
  let book: BookCtx;

  beforeEach(() => {
    d1 = createTestD1(testSchema());
    const { meta, lines } = song();
    book = { hash: "s1", title: "Chanson", lang: "fr", clipOf: songClipFinder(meta, lines) };
  });

  const entries = async () => {
    const list = (await new WordsD1Repo(d1, EMAIL).lists()).find((l) => l.source === "book:s1")!;
    return new WordEntriesD1Repo(d1, EMAIL).entries(list.id);
  };

  test("制卡: the entry has the line's clip; /words is served it with the example", async () => {
    await makeCards(
      d1,
      EMAIL,
      book,
      [
        { w: "chien", ex: "Le chien court dans la rue", back: "dog" },
        { w: "loup", ex: "Le loup dort sous la lune", back: "wolf" },
      ],
      NOW,
    );
    const got = await entries();
    expect(got.map((e) => [e.term, parseCardClip(e.clip)])).toEqual([
      ["chien", { v: V, t0: 1_000, t1: 4_000 }],
      ["loup", { v: V, t0: 4_000, t1: 8_000 }],
    ]);
  });

  test("the client never chooses the clip: a word's example from no line has none", async () => {
    await makeCards(d1, EMAIL, book, [{ w: "chien", ex: "Un chien inventé." }, { w: "loup" }], NOW);
    expect((await entries()).every((e) => e.clip === undefined)).toBe(true);
  });

  test("graded in the reader's review: the entry gets the clip; the review item carries it", async () => {
    const words = [{ w: "chien", ex: "Le chien court dans la rue" }];
    const s = await scopeSession(d1, EMAIL, book, words, undefined, NOW);
    expect(parseCardClip(s.items[0].clip)).toEqual({ v: V, t0: 1_000, t1: 4_000 });
    await new WordsD1Repo(d1, EMAIL).review(
      s.items[0].listId,
      [{ term: "chien", rating: 3 }],
      "2026-11-09",
      NOW,
    );
    expect(await addGradedEntries(d1, EMAIL, book, words)).toBe(1);
    expect(parseCardClip((await entries())[0].clip)?.t0).toBe(1_000);
  });

  test("an entry made before clips were kept gets its clip, only for the same example", async () => {
    const plain: BookCtx = { ...book, clipOf: undefined };
    await makeCards(
      d1,
      EMAIL,
      plain,
      [
        { w: "chien", ex: "Le chien court dans la rue" },
        { w: "loup", ex: "Autre phrase." },
      ],
      NOW,
    );
    expect((await entries()).every((e) => e.clip === undefined)).toBe(true);
    await addGradedEntries(d1, EMAIL, book, [
      { w: "chien", ex: "Le chien court dans la rue" },
      { w: "loup", ex: "Le loup dort sous la lune" },
    ]);
    const got = await entries();
    expect(parseCardClip(got.find((e) => e.term === "chien")!.clip)?.t0).toBe(1_000);
    // "loup"'s stored example is another sentence: its clip would not match it.
    expect(got.find((e) => e.term === "loup")!.clip).toBeUndefined();
  });
});

describe("example-pick: a clip goes where its sentence goes", () => {
  test("the picked example brings its own clip, never the other's", () => {
    const e = {
      ex: "A",
      clip: "clipA",
      exs: [{ ex: "B" }],
    };
    expect(examplesOf(e)).toEqual([{ ex: "A", clip: "clipA" }, { ex: "B" }]);
    const b = withPickedExample(e, "k-test", () => 0.99);
    const a = withPickedExample(e, "k-test2", () => 0);
    const pick = [a, b];
    const seen = pick.map((x) => `${x.ex}:${x.clip ?? "-"}`).sort();
    expect(seen).toEqual(["A:clipA", "B:-"]);
  });
});
