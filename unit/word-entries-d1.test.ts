import { beforeEach, describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordEntriesD1Repo } from "@/lib/repos/wordEntriesD1";

const SCHEMA = testSchema();
const EMAIL = "u@example.com";
const LIST = "list-1";

let d1: TestD1Database;
let repo: WordEntriesD1Repo;
beforeEach(async () => {
  d1 = createTestD1(SCHEMA);
  repo = new WordEntriesD1Repo(d1, EMAIL);
  await d1
    .prepare(
      `INSERT INTO word_lists (email, id, name, lang, source, created_at, updated_at)
       VALUES (?, ?, 'Spanish', 'es', 'anki:1', 'x', 'x')`,
    )
    .bind(EMAIL, LIST)
    .run();
});

const card = async (term: string, back = "") => {
  await d1
    .prepare(
      `INSERT INTO word_cards (email, list_id, term, back, card, card_due, reps, updated_at)
       VALUES (?, ?, ?, ?, '{}', 'x', 1, 'x')`,
    )
    .bind(EMAIL, LIST, term, back)
    .run();
  await d1
    .prepare(
      `INSERT INTO word_reviews (email, list_id, term, rating, state, reviewed_at)
       VALUES (?, ?, ?, 3, 0, 'x')`,
    )
    .bind(EMAIL, LIST, term)
    .run();
};
const terms = async (table: string) =>
  (
    await d1
      .prepare(`SELECT term FROM ${table} WHERE email = ? AND list_id = ? ORDER BY term`)
      .bind(EMAIL, LIST)
      .all<{ term: string }>()
  ).results.map((r) => r.term);

describe("WordEntriesD1Repo", () => {
  test("first import adds in order, with optional fields", async () => {
    const r = await repo.sync(LIST, [
      { key: "a", term: "hola", back: "hello", ex: "¡Hola!", exTr: "Hi!" },
      { key: "b", term: "gato", back: "cat", reading: "GA-to" },
    ]);
    expect(r).toEqual({ added: 2, updated: 0, unchanged: 0, renamed: 0, duplicates: 0 });
    expect(await repo.entries(LIST)).toEqual([
      { term: "hola", back: "hello", ex: "¡Hola!", exTr: "Hi!" },
      { term: "gato", back: "cat", reading: "GA-to" },
    ]);
  });

  test("re-import updates by key, keeps positions and history, appends new notes", async () => {
    await repo.sync(LIST, [
      { key: "a", term: "hola", back: "hello" },
      { key: "b", term: "gato", back: "cat" },
      { key: "c", term: "perro", back: "dog" },
    ]);
    await card("gato", "cat");
    await card("perro", "dog");
    const r = await repo.sync(LIST, [
      { key: "d", term: "casa", back: "house" }, // new: appended, though first in the file
      { key: "c", term: "perro", back: "dog" },
      { key: "b", term: "gata", back: "she-cat" }, // renamed and re-glossed
      { key: "a", term: "hola", back: "hello", reading: "O-la" },
      { key: "a", term: "hola", back: "dup key" },
      { key: "e", term: "perro", back: "another dog" }, // term held by "c"
    ]);
    expect(r).toEqual({ added: 1, updated: 2, unchanged: 1, renamed: 1, duplicates: 2 });
    expect((await repo.entries(LIST)).map((e) => e.term)).toEqual([
      "hola",
      "gata",
      "perro",
      "casa",
    ]);
    expect(await terms("word_cards")).toEqual(["gata", "perro"]);
    expect(await terms("word_reviews")).toEqual(["gata", "perro"]);
    const back = await d1
      .prepare("SELECT back FROM word_cards WHERE email = ? AND term = 'gata'")
      .bind(EMAIL)
      .first<{ back: string }>();
    expect(back?.back).toBe("she-cat");
  });

  test("a rename onto a term that already has a card leaves both cards alone", async () => {
    await repo.sync(LIST, [{ key: "a", term: "uno", back: "1" }]);
    await card("uno");
    await card("dos"); // a stray card, e.g. from a word no longer in the deck
    const r = await repo.sync(LIST, [{ key: "a", term: "dos", back: "2" }]);
    expect(r.renamed).toBe(1);
    expect(await terms("word_cards")).toEqual(["dos", "uno"]);
    expect(await terms("word_reviews")).toEqual(["dos", "uno"]);
  });

  test("entries no longer in the deck are kept", async () => {
    await repo.sync(LIST, [
      { key: "a", term: "uno", back: "1" },
      { key: "b", term: "dos", back: "2" },
    ]);
    await repo.sync(LIST, [{ key: "b", term: "dos", back: "2" }]);
    expect((await repo.entries(LIST)).map((e) => e.term)).toEqual(["uno", "dos"]);
  });

  test("works without batch() and deletes", async () => {
    const plain = { prepare: (q: string) => d1.prepare(q), exec: (q: string) => d1.exec(q) };
    const r = new WordEntriesD1Repo(plain, EMAIL);
    await r.sync(LIST, [{ key: "a", term: "uno", back: "1" }]);
    expect(await r.entries(LIST)).toHaveLength(1);
    await r.deleteAll(LIST);
    expect(await r.entries(LIST)).toHaveLength(0);
  });

  test("large imports are chunked", async () => {
    const many = Array.from({ length: 1234 }, (_, i) => ({
      key: `k${i}`,
      term: `w${i}`,
      back: "",
    }));
    expect((await repo.sync(LIST, many)).added).toBe(1234);
    const renamed = many.map((e) => ({ ...e, term: `${e.term}!` }));
    expect((await repo.sync(LIST, renamed)).renamed).toBe(1234);
    const entries = await repo.entries(LIST);
    expect(entries).toHaveLength(1234);
    expect(entries[1233].term).toBe("w1233!");
  });
});
