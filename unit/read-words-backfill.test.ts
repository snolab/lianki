// Books imported before word counting (#448, e.g. the owner's French EPUB of
// 2026-11-03) get their word count on first read, saved back once, with no
// re-import; and a book's first pass is recorded once, never overwritten.
import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { useBackend, useBlobs, useD1 } from "./support/testMocks";

const { getReadMaterialById, saveReadMaterial, getReadMaterialContent } =
  await import("@/lib/getReadMaterialsCollection");
const { materialWords, summarizeMaterials } = await import("@/lib/read/progress");
const { countWords } = await import("@/lib/read/words");
const { BOOK_KIND, parseBookMeta } = await import("@/lib/read/book");

let d1: TestD1Database;
let store: Map<string, string>;

beforeEach(() => {
  d1 = createTestD1(testSchema());
  store = new Map();
  useD1(d1);
  useBackend("d1");
  useBlobs({
    put: async (k: string, v: string) => void store.set(k, v),
    get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
    delete: async (k: string) => void store.delete(k),
  });
});

/** The meta a #448 import stored: no `words`. */
const oldMeta = (lang: string, chapters = [{ title: "I", start: 0 }]) =>
  JSON.stringify({ kind: BOOK_KIND, v: 1, source: "epub", lang, chapters, headings: [] });

describe("backfill of books imported before word counting", () => {
  it("counts a small book on first read, saves it inline, and reuses it", async () => {
    const lines = ["Le petit prince regarde la rose.", "La rose est belle."];
    const saved = await saveReadMaterial("u1", "Le Petit Prince", oldMeta("fr"), lines);
    const m = (await getReadMaterialById("u1", String(saved._id)))!;
    expect(parseBookMeta(await getReadMaterialContent(m))?.words).toBeUndefined();

    const first = await materialWords(m, "u1");
    expect(first.stats.lang).toBe("fr");
    expect(first.stats.tokens).toBe(10);

    const again = (await getReadMaterialById("u1", String(saved._id)))!;
    const stored = parseBookMeta(await getReadMaterialContent(again));
    expect(stored?.words?.tokens).toBe(10);
    expect(stored?.chapters).toEqual([{ title: "I", start: 0 }]); // nothing else lost
    expect(again.updatedAt.toISOString()).toBe(m.updatedAt.toISOString()); // list order kept
  });

  it("moves a book whose meta outgrows the inline limit to R2", async () => {
    // 5000 distinct words: the counted meta is far over 32 KB.
    const word = (i: number) =>
      "w" + [...i.toString(26)].map((c) => String.fromCharCode(97 + parseInt(c, 26))).join("");
    const lines = Array.from({ length: 500 }, (_, l) =>
      Array.from({ length: 10 }, (_, k) => word(l * 10 + k)).join(" "),
    );
    const saved = await saveReadMaterial("u1", "Big", oldMeta("en"), lines);
    const m = (await getReadMaterialById("u1", String(saved._id)))!;
    expect(m.r2Key).toBeUndefined();
    const { stats } = await materialWords(m, "u1");
    const row = await d1
      .prepare("SELECT r2_key, content FROM read_materials WHERE id = ?")
      .bind(String(saved._id))
      .first<{ r2_key: string | null; content: string | null }>();
    expect(row?.content).toBeNull();
    expect(row?.r2_key).toBe(`read/${saved._id}`);
    expect(parseBookMeta(store.get(row!.r2_key!)!)?.words?.tokens).toBe(stats.tokens);
  });

  it("another user's id is never backfilled", async () => {
    const saved = await saveReadMaterial("u1", "T", oldMeta("en"), ["One cat."]);
    expect(await getReadMaterialById("u2", String(saved._id))).toBeNull();
  });
});

describe("the first pass is recorded once", () => {
  it("sets passed_at on the first pass and keeps it after a drop", async () => {
    const now = new Date().toISOString();
    await d1
      .prepare(
        "INSERT INTO word_lists (email, id, name, lang, created_at, updated_at) VALUES ('me@x', 'l', 'l', 'en', ?, ?)",
      )
      .bind(now, now)
      .run();
    const put = (term: string, days: number) =>
      d1
        .prepare(
          "INSERT OR REPLACE INTO word_cards (email, list_id, term, card, card_due, updated_at) VALUES ('me@x', 'l', ?, ?, ?, ?)",
        )
        .bind(term, JSON.stringify({ stability: days, scheduled_days: days, state: 2 }), now, now)
        .run();
    const saved = await saveReadMaterial("u1", "T", oldMeta("en"), ["The cat sat."]);
    const user = { id: "u1", email: "me@x" };
    const load = async () => {
      const m = (await getReadMaterialById("u1", String(saved._id)))!;
      return (
        await summarizeMaterials(d1, user, [
          { material: m, stats: (await materialWords(m, "u1")).stats },
        ])
      )[0];
    };

    await put("the", 400);
    expect((await load()).passedAt).toBeNull(); // 1 of 3
    await put("cat", 400);
    await put("sat", 400);
    const passed = await load();
    expect(passed.passed).toBe(true);
    expect(passed.coverage).toBe(100);
    expect(passed.passedAt).not.toBeNull();

    await put("sat", 3); // forgotten: below 95%
    const after = await load();
    expect(after.passed).toBe(false);
    expect(after.passedAt).toBe(passed.passedAt);
  });
});

describe("when the cards cannot be read", () => {
  it("still shows the word count, with no progress and no pass", async () => {
    const broken = {
      prepare: () => {
        throw new Error("D1 down");
      },
      exec: async () => {},
    };
    const stats = countWords(["The cat sat."], "en");
    const [sum] = await summarizeMaterials(broken, { id: "u1", email: "me@x" }, [
      { material: { _id: "x" }, stats },
    ]);
    expect(sum.tokens).toBe(3);
    expect(sum.progress).toBeNull();
    expect(sum.coverage).toBeNull();
    expect(sum.passedAt).toBeNull();
  });
  it("a recorded pass is shown even without cards", async () => {
    const stats = countWords(["The cat sat."], "en");
    const at = new Date("2026-11-03T08:00:00Z");
    const [sum] = await summarizeMaterials(null, { id: "u1" }, [
      { material: { _id: "x", passedAt: at }, stats },
    ]);
    expect(sum.passedAt).toBe(at.toISOString());
    expect(sum.passed).toBe(false);
  });
  it("pasted text is counted on each read, never written back", async () => {
    const saved = await saveReadMaterial("u1", "Paste", "One cat.\nTwo cats.", [
      "One cat.",
      "Two cats.",
    ]);
    const m = (await getReadMaterialById("u1", String(saved._id)))!;
    const w = await materialWords(m, "u1");
    expect(w.book).toBeNull();
    expect(w.text).toBe("One cat.\nTwo cats.");
    expect(w.stats.tokens).toBe(4);
  });
  it("a backfill that cannot be saved still returns the count", async () => {
    const saved = await saveReadMaterial("u1", "T", oldMeta("en"), ["One cat."]);
    const m = (await getReadMaterialById("u1", String(saved._id)))!;
    useBackend("d1");
    useD1({
      prepare: () => {
        throw new Error("D1 down");
      },
      exec: async () => {},
    });
    const w = await materialWords(m, "u1");
    expect(w.stats.tokens).toBe(2);
  });
});
