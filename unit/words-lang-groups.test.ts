import { describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1 } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { flatten } from "@/lib/words/tree";
import {
  languageNames,
  newGroupKey,
  planLanguageGroups,
  planUndo,
  seriesOf,
  seriesStatus,
  shownName,
  type GroupingPlan,
  type GroupingUndo,
  type PlanList,
} from "@/lib/words/lang-groups";

const G = "group:words";
const CATALOG = [
  "ja-jlpt-n5",
  "ja-jlpt-n4",
  "ja-jlpt-n3",
  "ja-jlpt-n2",
  "ja-jlpt-n1",
  "fr-freq-1",
  "fr-freq-2",
];
const rank = (s: string | null) => {
  const i = CATALOG.indexOf(s ?? "");
  return i < 0 ? undefined : i;
};
const NAMES: Record<string, string[]> = {
  ja: ["Japonais", "Japanese"],
  fr: ["Français", "French"],
};
const opts = { groupSource: G, rank, names: (l: string) => NAMES[l] ?? [l] };

const list = (id: string, lang: string, source: string | null, parentId: string | null = null) =>
  ({ id, name: id, lang, source, parentId }) satisfies PlanList;
const group = (id: string, name: string, lang = "mul", parentId: string | null = null) =>
  ({ id, name, lang, source: G, parentId }) satisfies PlanList;
const tree = (o: { id: string; parentId: string | null }[]) =>
  o.map((x) => (x.parentId ? `${x.parentId} > ${x.id}` : x.id));

const JA = newGroupKey("ja");
const JLPT = newGroupKey("ja", "JLPT");
const FR = newGroupKey("fr");

/** Apply a plan as the server does: the new groups get real ids. */
function apply(lists: PlanList[], plan: GroupingPlan) {
  const real = new Map(plan.create.map((c) => [c.key, `g-${c.key.slice(10).replace("/", "-")}`]));
  const id = (x: string | null) => (x ? (real.get(x) ?? x) : x);
  const rows = new Map(lists.map((l) => [l.id, l]));
  for (const c of plan.create)
    rows.set(real.get(c.key)!, group(real.get(c.key)!, c.name, c.lang, id(c.parentId)));
  return plan.order.map((o) => ({ ...rows.get(id(o.id)!)!, parentId: id(o.parentId) }));
}

describe("language groups", () => {
  test("shown name drops the language prefix only inside a group of that language", () => {
    const n3 = { name: "Japanese · JLPT N3", lang: "ja" };
    expect(shownName(n3, { name: "JLPT", lang: "ja" })).toBe("JLPT N3");
    expect(shownName(n3, { name: "Mine", lang: "mul" })).toBe(n3.name);
    expect(shownName(n3, null)).toBe(n3.name);
    expect(shownName({ name: "My deck", lang: "ja" }, { name: "J", lang: "ja" })).toBe("My deck");
  });

  test("series: JLPT and HSK get a middle level, frequency lists do not", () => {
    expect(seriesOf("ja-jlpt-n5")).toBe("JLPT");
    expect(seriesOf("zh-hsk-7-9")).toBe("HSK");
    expect(seriesOf("fr-freq-1")).toBeUndefined();
    expect(seriesOf("anki:123")).toBeUndefined();
    expect(seriesOf(null)).toBeUndefined();
  });

  test("Japanese → JLPT → N5…N1, French → its lists, imported decks after", () => {
    const lists = [
      list("n3", "ja", "ja-jlpt-n3"),
      list("fr1", "fr", "fr-freq-1"),
      list("n5", "ja", "ja-jlpt-n5"),
      list("deck", "ja", "anki:123"),
      list("n1", "ja", "ja-jlpt-n1"),
    ];
    const plan = planLanguageGroups(lists, opts);
    expect(plan.create).toEqual([
      { key: JA, name: "Japonais", lang: "ja", parentId: null },
      { key: JLPT, name: "JLPT", lang: "ja", parentId: JA },
      { key: FR, name: "Français", lang: "fr", parentId: null },
    ]);
    // The language group stands where its first list stood.
    expect(tree(plan.order)).toEqual([
      JA,
      `${JA} > ${JLPT}`,
      `${JLPT} > n5`,
      `${JLPT} > n3`,
      `${JLPT} > n1`,
      `${JA} > deck`,
      FR,
      `${FR} > fr1`,
    ]);
    expect(plan.moved).toContainEqual({ id: "deck", into: JA });
    expect(plan.moved).toContainEqual({ id: "n5", into: JLPT });
  });

  test("manual structure wins: nested lists stay, existing groups are reused", () => {
    const lists = [
      group("mine", "Exam prep"),
      list("n2", "ja", "ja-jlpt-n2", "mine"),
      group("jp", "japanese"), // a group he named himself, no language set
      list("own", "ja", "anki:9", "jp"),
      group("jl", "JLPT", "mul", "jp"),
      list("n4", "ja", "ja-jlpt-n4"),
      list("n5", "ja", "ja-jlpt-n5"),
    ];
    const plan = planLanguageGroups(lists, opts);
    expect(plan.create).toEqual([]);
    expect(tree(plan.order)).toEqual([
      "mine",
      "mine > n2",
      "jp",
      "jp > own",
      "jp > jl",
      "jl > n5",
      "jl > n4",
    ]);
  });

  test("a group of that language wins over one only named like it", () => {
    const lists = [
      group("named", "Japanese"),
      group("coded", "日本語", "ja"),
      list("deck", "ja", "anki:5"),
    ];
    expect(planLanguageGroups(lists, opts).moved).toEqual([{ id: "deck", into: "coded" }]);
  });

  test("a JLPT group he made at the top level is used as it is", () => {
    const lists = [group("jl", "JLPT"), list("n5", "ja", "ja-jlpt-n5")];
    const plan = planLanguageGroups(lists, opts);
    expect(plan.create).toEqual([]); // no empty "Japanese" around it
    expect(plan.moved).toEqual([{ id: "n5", into: "jl" }]);
    expect(tree(plan.order)).toEqual(["jl", "jl > n5"]);
  });

  test("groups, 'mul' lists and nothing-to-do pages are left alone", () => {
    const lists = [group("g", "Misc"), list("x", "mul", "anki:1"), list("y", "", null)];
    expect(planLanguageGroups(lists, opts)).toEqual({
      create: [],
      moved: [],
      order: [
        { id: "g", parentId: null },
        { id: "x", parentId: null },
        { id: "y", parentId: null },
      ],
    });
  });

  test("running it twice changes nothing", () => {
    const lists = [
      list("fr2", "fr", "fr-freq-2"),
      list("n5", "ja", "ja-jlpt-n5"),
      list("fr1", "fr", "fr-freq-1"),
      list("n4", "ja", "ja-jlpt-n4"),
    ];
    const once = apply(lists, planLanguageGroups(lists, opts));
    const twice = planLanguageGroups(once, opts);
    expect(twice.create).toEqual([]);
    expect(twice.moved).toEqual([]);
    expect(twice.order).toEqual(once.map((l) => ({ id: l.id, parentId: l.parentId })));
  });

  test("a list's own sublists come along", () => {
    const lists = [list("deck", "ja", "anki:1"), list("sub", "mul", "anki:2", "deck")];
    expect(tree(planLanguageGroups(lists, opts).order)).toEqual([JA, `${JA} > deck`, "deck > sub"]);
  });

  test("nothing is lost, every row once", () => {
    const lists = [
      list("a", "ja", "ja-jlpt-n1"),
      group("g", "G"),
      list("b", "fr", "fr-freq-1", "g"),
      list("c", "fr", "fr-freq-2"),
      list("orphan", "ja", "ja-jlpt-n5", "gone"),
    ];
    const plan = planLanguageGroups(lists, opts);
    const ids = plan.order.map((o) => o.id).filter((id) => !id.startsWith("new-group:"));
    expect(ids.sort()).toEqual(["a", "b", "c", "g", "orphan"]);
    expect(new Set(plan.order.map((o) => o.id)).size).toBe(plan.order.length);
  });
});

describe("undo grouping", () => {
  const lists = [
    list("n3", "ja", "ja-jlpt-n3"),
    group("mine", "Mine"),
    list("fr1", "fr", "fr-freq-1"),
    list("n5", "ja", "ja-jlpt-n5"),
  ];
  const plan = planLanguageGroups(lists, opts);
  const after = apply(lists, plan);
  const real = (k: string) => `g-${k.slice(10).replace("/", "-")}`;
  const undo: GroupingUndo = {
    before: lists.map((l) => ({ id: l.id, parentId: l.parentId })),
    after: after.map((l) => ({ id: l.id, parentId: l.parentId })),
    created: plan.create.map((c) => real(c.key)),
    moved: plan.moved.map((m) => ({ id: m.id, into: real(m.into) })),
  };

  test("untouched since: exactly the tree before, every new group dropped", () => {
    const r = planUndo(after, undo);
    expect(r.order).toEqual(undo.before);
    expect(r.drop.sort()).toEqual(["g-fr", "g-ja", "g-ja-JLPT"]);
  });

  test("changed since: what he moved himself stays; a group still holding his lists stays", () => {
    // He dragged n5 into his own group, and imported a deck into Japanese.
    const now = after.map((l) => (l.id === "n5" ? { ...l, parentId: "mine" } : l));
    now.push(list("deck", "ja", "anki:7", "g-ja"));
    const r = planUndo(now, undo);
    expect(r.drop.sort()).toEqual(["g-fr", "g-ja-JLPT"]);
    const by = new Map(r.order.map((o) => [o.id, o.parentId]));
    expect(by.get("n3")).toBeNull();
    expect(by.get("n5")).toBe("mine");
    expect(by.get("deck")).toBe("g-ja");
    expect(by.get("fr1")).toBeNull();
    expect(by.has("g-fr")).toBe(false);
  });
});

describe("groupByLanguage on D1 (once per account, undoable)", () => {
  const onPage = (l: { source: string | null }) => l.source !== "ko-jamo";
  const run = (repo: WordsD1Repo) =>
    repo.groupByLanguage({
      onPage,
      groupSource: G,
      rank,
      names: (l) => languageNames(l, "fr"),
    });
  const shape = async (repo: WordsD1Repo) =>
    flatten((await repo.lists()).filter(onPage)).map((l) => `${"  ".repeat(l.depth)}${l.name}`);

  test("groups, runs once, two devices at once still once, undo restores", async () => {
    const d1 = createTestD1(testSchema());
    const repo = new WordsD1Repo(d1, "a@example.com");
    const other = new WordsD1Repo(d1, "b@example.com");
    for (const [name, lang, source] of [
      ["Japanese · JLPT N3", "ja", "ja-jlpt-n3"],
      ["French · top 1–500", "fr", "fr-freq-1"],
      ["Japanese · JLPT N5", "ja", "ja-jlpt-n5"],
      ["Korean · Hangul jamo", "ko", "ko-jamo"],
    ])
      await repo.createList({ name, lang, source });
    await other.createList({ name: "Japanese · JLPT N5", lang: "ja", source: "ja-jlpt-n5" });
    const before = await shape(repo);

    const [a, b] = await Promise.all([run(repo), run(repo)]);
    expect([a.applied, b.applied].sort()).toEqual([false, true]);
    expect(a.created + b.created).toBe(3);
    expect(await shape(repo)).toEqual([
      "Japonais",
      "  JLPT",
      "    Japanese · JLPT N5",
      "    Japanese · JLPT N3",
      "Français",
      "  French · top 1–500",
    ]);
    // Another page's list (/alphabets) is not moved.
    const jamo = (await repo.lists()).find((l) => l.source === "ko-jamo")!;
    expect([jamo.parentId, jamo.name]).toEqual([null, "Korean · Hangul jamo"]);
    const grouped = await shape(repo);
    expect((await run(repo)).applied).toBe(false);
    expect(await shape(repo)).toEqual(grouped);
    // Someone else's lists are never touched.
    expect(await shape(other)).toEqual(["Japanese · JLPT N5"]);

    expect(await repo.undoGroupByLanguage(onPage)).toBe(true);
    expect(await shape(repo)).toEqual(before);
    // Undone stays undone: neither undo nor the grouping runs again.
    expect(await repo.undoGroupByLanguage(onPage)).toBe(false);
    expect((await run(repo)).applied).toBe(false);
    expect(await shape(repo)).toEqual(before);
  });

  test("names come in the app's language, English as the fallback", () => {
    expect(languageNames("ja", "fr")).toEqual(["Japonais", "Japanese", "ja"]);
    expect(languageNames("ja")).toEqual(["Japanese", "ja"]);
    expect(languageNames("ja", "not a locale!")[0]).toBe("Japanese");
  });
});

describe("adding a whole series from the catalog", () => {
  const JLPT_IDS = CATALOG.slice(0, 5);

  test("what he lacks, has at the top level, has inside a group", () => {
    const lists = [
      group("mine", "Mine"),
      list("n3", "ja", "ja-jlpt-n3", "mine"),
      list("n5", "ja", "ja-jlpt-n5"),
    ];
    expect(seriesStatus(lists, JLPT_IDS)).toEqual({
      missing: ["ja-jlpt-n4", "ja-jlpt-n2", "ja-jlpt-n1"],
      top: ["n5"],
      nested: ["n3"],
    });
  });

  test("only the new lists move; his own top-level lists stay unless he says so", () => {
    const lists = [
      list("fr1", "fr", "fr-freq-1"),
      list("n5", "ja", "ja-jlpt-n5"), // his, top level, he said no
      list("n4", "ja", "ja-jlpt-n4"), // just added
      list("n1", "ja", "ja-jlpt-n1"), // just added
    ];
    const no = planLanguageGroups(lists, { ...opts, only: new Set(["n4", "n1"]) });
    expect(tree(no.order)).toEqual([
      "fr1",
      "n5",
      JA,
      `${JA} > ${JLPT}`,
      `${JLPT} > n4`,
      `${JLPT} > n1`,
    ]);
    const yes = planLanguageGroups(lists, { ...opts, only: new Set(["n4", "n1", "n5"]) });
    expect(tree(yes.order)).toEqual([
      "fr1",
      JA,
      `${JA} > ${JLPT}`,
      `${JLPT} > n5`,
      `${JLPT} > n4`,
      `${JLPT} > n1`,
    ]);
  });

  test("an existing Japanese group takes the series inside it", () => {
    const lists = [
      group("jp", "Japanese", "ja"),
      list("deck", "ja", "anki:1", "jp"),
      list("n5", "ja", "ja-jlpt-n5"),
    ];
    const plan = planLanguageGroups(lists, { ...opts, only: new Set(["n5"]) });
    expect(plan.create).toEqual([{ key: JLPT, name: "JLPT", lang: "ja", parentId: "jp" }]);
    expect(tree(plan.order)).toEqual(["jp", "jp > deck", `jp > ${JLPT}`, `${JLPT} > n5`]);
  });
});
