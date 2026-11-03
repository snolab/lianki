import { describe, expect, test } from "bun:test";
import { kindOf, planArrange, type ArrangeMeta } from "@/lib/words/arrange";

type R = { id: string; parentId: string | null; name: string; lang: string; source?: string };
const G = "group:words";
const catalog: Record<string, ArrangeMeta> = {
  "ja-jlpt-n5": { exam: "JLPT", order: 1 },
  "ja-jlpt-n4": { exam: "JLPT", order: 2 },
  "ja-jlpt-n1": { exam: "JLPT", order: 5 },
  "ja-phrases-greetings": { kind: "phrase", scenario: "greetings", order: 1 },
  "ja-phrases-work": { kind: "phrase", scenario: "work", order: 7 },
  "en-freq-1": { order: 1 },
  "en-freq-2": { order: 2 },
};
const index = Object.keys(catalog);
const labels = { freq: "Most common words", phrase: "Phrases", exam: "Exam word lists" };
const opts = {
  isGroup: (r: R) => r.source === G,
  metaOf: (r: R) => catalog[r.source ?? ""],
  catalogIndex: (r: R) => index.indexOf(r.source ?? ""),
  kindLabels: labels,
};
const list = (id: string, lang: string, parentId: string | null = null, name = id): R => ({
  id,
  parentId,
  name,
  lang,
  source: catalog[id] ? id : undefined,
});
const group = (id: string, name: string, lang = "mul", parentId: string | null = null): R => ({
  id,
  parentId,
  name,
  lang,
  source: G,
});

/** Apply a plan with made-up ids for new groups; the tree as "parent/child" lines. */
function run(rows: R[]) {
  const plan = planArrange(rows, opts);
  const ids = new Map(plan.make.map((g) => [g.key, `new:${g.key}`]));
  const order = plan.order(ids);
  return { plan, order, lines: order.map((o) => `${o.parentId ?? "-"} > ${o.id}`) };
}

describe("arrange his lists", () => {
  test("kinds from the catalog data", () => {
    expect(kindOf(catalog["ja-jlpt-n5"])).toBe("exam");
    expect(kindOf(catalog["ja-phrases-work"])).toBe("phrase");
    expect(kindOf(catalog["en-freq-1"])).toBe("freq");
    expect(kindOf(undefined)).toBe(null);
  });

  test("language → kind → lists in learning order; his own decks by name, last", () => {
    const { plan, lines } = run([
      list("ja-jlpt-n1", "ja"),
      list("ja-phrases-work", "ja"),
      list("ja-jlpt-n5", "ja"),
      list("my-anime", "ja", null, "Anime words"),
      list("ja-phrases-greetings", "ja"),
      list("my-a", "ja", null, "A deck"),
      list("ja-jlpt-n4", "ja"),
    ]);
    expect(plan.make.map((g) => g.key)).toEqual(["lang:ja", "ja/phrase", "ja/exam"]);
    expect(lines).toEqual([
      "- > new:lang:ja",
      "new:lang:ja > new:ja/phrase",
      "new:ja/phrase > ja-phrases-greetings",
      "new:ja/phrase > ja-phrases-work",
      "new:lang:ja > new:ja/exam",
      "new:ja/exam > ja-jlpt-n5",
      "new:ja/exam > ja-jlpt-n4",
      "new:ja/exam > ja-jlpt-n1",
      "new:lang:ja > my-a",
      "new:lang:ja > my-anime",
    ]);
  });

  test("one kind only: its lists right under the language", () => {
    const { plan, lines } = run([list("en-freq-2", "en"), list("en-freq-1", "en")]);
    expect(plan.make.map((g) => g.key)).toEqual(["lang:en"]);
    expect(lines).toEqual([
      "- > new:lang:en",
      "new:lang:en > en-freq-1",
      "new:lang:en > en-freq-2",
    ]);
  });

  test("reuses his groups; leftovers stay, at the end; nothing is dropped", () => {
    const rows = [
      group("g-old", "Old stuff"),
      group("g-ja", "日本語", "ja"),
      list("ja-jlpt-n4", "ja", "g-old"),
      group("g-phr", "Phrases", "ja", "g-ja"),
      list("ja-phrases-work", "ja", "g-phr"),
      list("ja-jlpt-n5", "ja", "g-ja"),
      group("g-sub", "inner", "mul", "g-old"),
    ];
    const { plan, order, lines } = run(rows);
    // the Phrases group and the language group are his; only Exam word lists is new
    expect(plan.make.map((g) => g.key)).toEqual(["ja/exam"]);
    expect(lines).toEqual([
      "- > g-ja",
      "g-ja > g-phr",
      "g-phr > ja-phrases-work",
      "g-ja > new:ja/exam",
      "new:ja/exam > ja-jlpt-n5",
      "new:ja/exam > ja-jlpt-n4",
      "- > g-old",
      "g-old > g-sub",
    ]);
    expect(order.map((o) => o.id).sort()).toEqual([...rows.map((r) => r.id), "new:ja/exam"].sort());
  });

  test("arranging twice changes nothing", () => {
    const first = run([
      list("ja-jlpt-n4", "ja"),
      list("ja-phrases-work", "ja"),
      list("ja-jlpt-n5", "ja"),
    ]);
    const made = first.plan.make.map((g) => ({
      ...group(`new:${g.key}`, g.kind ? labels[g.kind] : "Japanese", g.lang),
    }));
    const rows: R[] = [
      ...made,
      list("ja-jlpt-n4", "ja"),
      list("ja-phrases-work", "ja"),
      list("ja-jlpt-n5", "ja"),
    ];
    const after = first.order.map((o) => ({
      ...rows.find((r) => r.id === o.id)!,
      parentId: o.parentId,
    }));
    const second = run(after);
    expect(second.plan.make).toEqual([]);
    expect(second.lines).toEqual(first.lines);
  });
});
