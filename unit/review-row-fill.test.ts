/**
 * A review list's rows ask for what they lack only when near the screen (owner,
 * 2026-11-06 23:07 JST: "gain/issues have no explaination"; 2026-11-07 16:39: the
 * example's translation): a few at a time, each word once, and the commit carries
 * the answer instead of paying again. docs/books-plan.md, "Review a range's words".
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { useBackend, useD1 } from "./support/testMocks";
import type { BookCtx, RangeWord } from "@/lib/read/book-word-list";
import { fillGlosses, type Complete } from "@/lib/read/gloss-server";
import {
  createRowFill,
  nearQueue,
  rowTranslation,
  sameLanguage,
  type FillRow,
  type RowPatch,
} from "@/lib/read/review-row-fill";

const app = join(import.meta.dir, "../app");
const review = readFileSync(join(app, "(app)/read/[id]/reader-word-review.tsx"), "utf8");
const words = readFileSync(join(app, "(app)/words/WordsClient.tsx"), "utf8");
const route = readFileSync(join(app, "api/read/[id]/word-session/route.ts"), "utf8");

const tick = () => new Promise((r) => setTimeout(r, 0));
const row = (term: string, more: Partial<FillRow> = {}): FillRow => ({
  listId: "l",
  term,
  back: "",
  lang: "en",
  ...more,
});

function harness(opts: { to?: string; gloss?: (w: string) => string | null | Error } = {}) {
  const glossAsked: string[] = [];
  const transAsked: string[] = [];
  const hold: (() => void)[] = [];
  const patches = new Map<string, RowPatch>();
  const fill = createRowFill({
    to: opts.to ?? "zh",
    lanes: 2,
    wordOf: (_l, term) => (term.startsWith("card") ? undefined : { w: term, ex: `ex ${term}` }),
    gloss: async (w) => {
      glossAsked.push(w);
      await new Promise<void>((r) => hold.push(r));
      const out = opts.gloss ? opts.gloss(w) : `meaning of ${w}`;
      if (out instanceof Error) throw out;
      return out ? { term: w, back: out } : { term: w, back: null };
    },
    translate: async (text) => {
      transAsked.push(text);
      return `tr ${text}`;
    },
  });
  const patch = (_l: string, term: string, p: RowPatch) =>
    patches.set(term, { ...patches.get(term), ...p });
  const release = async () => {
    for (const r of hold.splice(0)) r();
    await tick();
    await tick();
  };
  return { fill, glossAsked, transAsked, patches, patch, release };
}

describe("nearQueue", () => {
  test("a few at a time, each key once; what left before its turn is dropped", async () => {
    const started: string[] = [];
    const done: (() => void)[] = [];
    const q = nearQueue(1, (k) => {
      started.push(k);
      return new Promise<void>((r) => done.push(r));
    });
    q.enter("a");
    q.enter("a");
    q.enter("b");
    q.enter("c");
    expect(started).toEqual(["a"]);
    q.leave("b");
    done.shift()!();
    await tick();
    expect(started).toEqual(["a", "c"]);
    done.shift()!();
    await tick();
    q.enter("a");
    expect(started).toEqual(["a", "c"]);
  });

  test("a failed ask frees its lane and is not asked again by itself", async () => {
    const started: string[] = [];
    const q = nearQueue(1, (k) => {
      started.push(k);
      return Promise.reject(new Error("no"));
    });
    q.enter("a");
    q.enter("b");
    await tick();
    await tick();
    q.enter("a");
    expect(started).toEqual(["a", "b"]);
  });

  test("now: past its turn, for a commit", () => {
    const started: string[] = [];
    const q = nearQueue(1, (k) => {
      started.push(k);
      return new Promise(() => {});
    });
    q.enter("a");
    q.enter("b");
    q.now("b");
    expect(started).toEqual(["a", "b"]);
  });
});

describe("meanings only for rows in view", () => {
  test("a row not near the screen asks nothing, however long the list", async () => {
    const h = harness();
    h.fill.enter(row("gain"), h.patch);
    await tick();
    expect(h.glossAsked).toEqual(["gain"]);
    expect(h.patches.get("gain")?.backState).toBe("loading");
    await h.release();
    expect(h.patches.get("gain")?.back).toBe("meaning of gain");
  });

  test("a row that scrolled away before its turn is never asked for", async () => {
    const h = harness();
    for (const w of ["a", "b", "c", "d"]) h.fill.enter(row(w), h.patch);
    expect(h.glossAsked).toEqual(["a", "b"]);
    h.fill.leave(row("c"));
    await h.release();
    expect(h.glossAsked).toEqual(["a", "b", "d"]);
  });

  test("seen again, it asks nothing more: what came is shown", async () => {
    const h = harness();
    h.fill.enter(row("gain"), h.patch);
    await h.release();
    h.fill.leave(row("gain"));
    h.patches.clear();
    h.fill.enter(row("gain"), h.patch);
    await tick();
    expect(h.glossAsked).toEqual(["gain"]);
    expect(h.patches.get("gain")?.back).toBe("meaning of gain");
  });

  test("a word with a meaning, or a card, asks nothing", async () => {
    const h = harness();
    h.fill.enter(row("deck", { back: "from a deck" }), h.patch);
    h.fill.enter(row("due", { card: "{}" }), h.patch);
    h.fill.enter(row("card-unknown"), h.patch);
    await tick();
    expect(h.glossAsked).toEqual([]);
  });

  test("none found, or the lookup failed: a calm state, nothing asked again", async () => {
    const h = harness({ gloss: (w) => (w === "gone" ? new Error("network") : null) });
    h.fill.enter(row("gone"), h.patch);
    h.fill.enter(row("name"), h.patch);
    await h.release();
    expect(h.patches.get("gone")).toMatchObject({ backState: "none" });
    expect(h.patches.get("name")).toMatchObject({ backState: "none" });
    h.fill.leave(row("gone"));
    h.fill.enter(row("gone"), h.patch);
    await h.release();
    expect(h.glossAsked).toEqual(["gone", "name"]);
  });
});

describe("one charge per word", () => {
  test("the commit waits for the ask on its way, and carries its answer", async () => {
    const h = harness();
    h.fill.enter(row("gain"), h.patch);
    const found = h.fill.meaningOf("l", "gain");
    expect(found).toBeDefined();
    await h.release();
    expect(await found).toEqual({ term: "gain", back: "meaning of gain" });
    expect(h.glossAsked).toEqual(["gain"]);
  });

  test("a word waiting its turn is asked at once when swiped, not by the commit too", async () => {
    const h = harness();
    for (const w of ["a", "b", "c"]) h.fill.enter(row(w), h.patch);
    expect(h.glossAsked).toEqual(["a", "b"]);
    const found = h.fill.meaningOf("l", "c");
    expect(h.glossAsked).toEqual(["a", "b", "c"]);
    await h.release();
    expect((await found)?.back).toBe("meaning of c");
    await h.release();
    expect(h.glossAsked).toEqual(["a", "b", "c"]);
  });

  describe("on the server", () => {
    let d1: TestD1Database;
    let calls = 0;
    const complete: Complete = async () => {
      calls++;
      return {
        choices: [{ message: { content: JSON.stringify({ zzmot: "paid once" }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      };
    };
    const ai = { userId: "user-a", complete };
    const BOOK: BookCtx = { hash: "h", title: "T", lang: "fr", names: new Set() };
    const x = (back: string | null = null): RangeWord => ({
      w: "zzmot",
      ex: null,
      term: null,
      reading: null,
      back,
    });
    beforeEach(() => {
      d1 = createTestD1(testSchema());
      // fillGlosses' rate limit reads getD1(): this file's own, never the last file's.
      useD1(d1);
      useBackend("d1");
      calls = 0;
    });

    test("the row's ask pays once; a commit carrying it, or after it, pays nothing", async () => {
      const [first] = await fillGlosses(d1, BOOK, [x()], ai);
      expect(first.back).toBe("paid once");
      expect(calls).toBe(1);
      // The commit with the meaning the row found.
      const [carried] = await fillGlosses(d1, BOOK, [x(first.back)], ai);
      expect(carried.back).toBe("paid once");
      // A commit without it (the row's answer was lost): word_gloss has it.
      const [again] = await fillGlosses(d1, BOOK, [x()], ai);
      expect(again.back).toBe("paid once");
      expect(calls).toBe(1);
    });

    test("the user's own AI: the commit asks no model of ours", async () => {
      await fillGlosses(d1, BOOK, [x()], null);
      expect(calls).toBe(0);
      expect(route).toContain("body.own === true ? null : { userId: ctx.userId }");
    });
  });
});

describe("translations", () => {
  test("asked for rows near the screen, once", async () => {
    const h = harness();
    h.fill.enter(row("due", { card: "{}", ex: "A line." }), h.patch);
    await tick();
    await tick();
    expect(h.transAsked).toEqual(["A line."]);
    expect(h.patches.get("due")?.exTr).toBe("tr A line.");
    h.fill.leave(row("due"));
    h.fill.enter(row("due", { card: "{}", ex: "A line." }), h.patch);
    await tick();
    expect(h.transAsked).toEqual(["A line."]);
  });

  test("not when the sentence is in his language, has one, or there is none", async () => {
    const h = harness({ to: "en-GB" });
    h.fill.enter(row("a", { card: "{}", ex: "A line." }), h.patch);
    const o = harness();
    o.fill.enter(row("b", { card: "{}", ex: "A line.", exTr: "有了" }), o.patch);
    o.fill.enter(row("c", { card: "{}" }), o.patch);
    await tick();
    expect(h.transAsked).toEqual([]);
    expect(o.transAsked).toEqual([]);
  });

  test("said back unchanged (a sentence in his language after all): not shown", async () => {
    const asked: string[] = [];
    const patches: RowPatch[] = [];
    const fill = createRowFill({
      to: "zh",
      wordOf: () => undefined,
      gloss: async () => null,
      translate: async (t) => {
        asked.push(t);
        return `  ${t} `;
      },
    });
    fill.enter(row("a", { card: "{}", ex: "已经是中文。" }), (_l, _t, p) => patches.push(p));
    await tick();
    await tick();
    expect(asked.length).toBe(1);
    expect(patches).toEqual([]);
  });

  test("sameLanguage goes by the base tag; an unknown one never matches", () => {
    expect(sameLanguage("en", "en-GB")).toBe(true);
    expect(sameLanguage("zh_TW", "zh")).toBe(true);
    expect(sameLanguage("en", "zh")).toBe(false);
    expect(sameLanguage("und", "und")).toBe(false);
    expect(sameLanguage(null, "en")).toBe(false);
  });

  test("a translator's note reads in brackets; a broken one never shows", () => {
    expect(rowTranslation("他说⟦一句礼貌话⟧谢谢")).toBe("他说 (一句礼貌话) 谢谢");
    expect(rowTranslation("plain")).toBe("plain");
    expect(rowTranslation("cut off⟦half a no")).toBe("cut off");
  });
});

describe("wiring", () => {
  test("the review uses the tap's paths, by his preferences; /vibe stays cached-only", () => {
    expect(review).toContain(
      "cachedOnly ? fetchCachedGloss(id, w, ex) : fetchGloss(id, w, ex, own)",
    );
    expect(review).toContain("const notes = readNotesOn();");
    expect(review).toContain("fetchPiece(id, to,");
    // With no model of ours for the user's own AI, and the row's answer on the commit.
    expect(review).toContain("...(own ? { own: true } : {})");
    expect(review).toContain("g?.back ? { ...w, term: w.term ?? g.term, back: g.back } : w");
  });

  test("Study asks through an observer on its rows, with no timer", () => {
    const at = words.indexOf("A review list's rows ask for what they lack");
    expect(at).toBeGreaterThan(0);
    const part = words.slice(at, words.indexOf("hasExamples", at));
    expect(part).toContain("new IntersectionObserver(");
    expect(part).not.toContain("setTimeout");
    expect(part).not.toContain("setInterval");
    // Opening a list asks nothing itself: the session's preview stays model-free.
    expect(route).toContain("fillGlosses(ctx.db, g.book, ws, null)");
  });
});
