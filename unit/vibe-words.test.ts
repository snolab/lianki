// The 新词 list (docs/vibe.md): the marks and the order, and no card without a
// swipe. Invented words only.
import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "fs";
import type { WordProbe } from "@/lib/read/batch-grade";
import type { WordRow } from "@/lib/read/reader-model";
import { PROBE_MAX, createCommits, firstHeard, heardWords, probeWords } from "@/lib/vibe/new-words";

const NOW = Date.parse("2026-11-06T00:00:00Z");
const probe = (w: string, due: string | null, reps = 3): WordProbe => ({
  w,
  listId: "l",
  term: w,
  due,
  reps,
});
//                          word, count, score, mastered, own, name, dict
const ROWS: WordRow[] = [
  ["bonjour", 2, -1, 0, 0, 0, 1],
  ["lyon", 5, -1, 0, 0, 1, 0],
  ["merci", 9, -1, 0, 0, 0, 1],
  ["chat", 1, 0.5, 0, 0, 0, 1],
  ["chien", 3, 0.9, 1, 0, 0, 1],
  ["pain", 4, 0.2, 0, 0, 0, 1],
];

describe("the list", () => {
  const due = new Map([
    ["chat", probe("chat", "2026-11-05T00:00:00Z")],
    ["pain", probe("pain", "2027-01-01T00:00:00Z")],
    ["chien", probe("chien", "2027-01-01T00:00:00Z")],
  ]);
  const list = heardWords(ROWS, due, NOW);

  it("puts what there is to add first, then due, learning, known", () => {
    expect(list.map((h) => [h.w, h.kind])).toEqual([
      ["merci", "new"],
      ["bonjour", "new"],
      ["chat", "due"],
      ["pain", "learning"],
      ["lyon", "known"],
      ["chien", "known"],
    ]);
  });

  it("uses the reader's own marks", () => {
    const by = new Map(list.map((h) => [h.w, h]));
    expect(by.get("merci")!.fam).toBe("n");
    expect(by.get("pain")!.fam).toBe("l1");
    expect(by.get("chat")!.fam).toBe("l2");
    expect(by.get("chien")!.fam).toBe("k");
    expect(by.get("merci")!.carded).toBe(false);
    expect(by.get("chat")!.carded).toBe(true);
  });

  it("a name suggests nothing", () => {
    expect(list.find((h) => h.w === "lyon")!.kind).toBe("known");
  });

  it("a card never reviewed is due; one past its day is due; one ahead is not", () => {
    const l = heardWords(
      [["a", 1, 0, 0, 0, 0, 1]],
      new Map([["a", probe("a", "2030-01-01T00:00:00Z", 0)]]),
      NOW,
    );
    expect(l[0].kind).toBe("due");
    expect(heardWords([["a", 1, 0, 0, 0, 0, 1]], new Map(), NOW)[0].kind).toBe("learning");
  });

  it("asks about cards only, within the route's cap", () => {
    expect(probeWords(ROWS).map((x) => x.w)).toEqual(["chat", "chien", "pain"]);
    const many: WordRow[] = Array.from({ length: 500 }, (_, i) => [`w${i}`, 1, 0.5, 0, 0, 0, 1]);
    expect(probeWords(many).length).toBe(PROBE_MAX);
  });

  it("finds the line it was first heard in, with its language", () => {
    const lines = [
      { text: "Bonjour, je suis là.", lang: "fr" },
      { text: "bonjour again", lang: "en" },
    ];
    expect(firstHeard("bonjour", lines)?.lang).toBe("fr");
    expect(firstHeard("absent", lines)).toBeNull();
  });
});

function desk() {
  const posted: Record<string, unknown>[] = [];
  const timers: { f: () => void; live: boolean }[] = [];
  let fail = false;
  let changes = 0;
  const failed: string[] = [];
  const d = createCommits({
    holdMs: 8000,
    newId: () => `id${posted.length}`,
    day: () => "2026-11-06",
    post: async (b) => {
      posted.push(b);
      if (fail) throw new Error("down");
      return {};
    },
    onChange: () => void changes++,
    onFailed: (w) => void failed.push(w),
    setTimer: (f) => {
      const t = { f, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  const fire = async () => {
    for (const t of timers) if (t.live) t.f();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    d,
    posted,
    fire,
    failed,
    changes: () => changes,
    setFail: (v: boolean) => {
      fail = v;
    },
  };
}

describe("no card without a swipe", () => {
  it("nothing is sent until the hold ends", async () => {
    const h = desk();
    h.d.commit("merci", "Merci beaucoup.", 3);
    expect(h.posted).toEqual([]);
    expect(h.d.state("merci")).toBe("held");
    await h.fire();
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({
      rating: 3,
      sentences: [],
      words: [{ w: "merci", ex: "Merci beaucoup." }],
      day: "2026-11-06",
    });
    expect(h.d.state("merci")).toBe("sent");
    expect(h.d.added()).toEqual(["merci"]);
  });

  it("Undo during the hold sends nothing at all", async () => {
    const h = desk();
    h.d.commit("merci", null, 3);
    h.d.undo("merci");
    await h.fire();
    expect(h.posted).toEqual([]);
    expect(h.d.has("merci")).toBe(false);
  });

  it("Undo after the send asks the server to take it back", async () => {
    const h = desk();
    h.d.commit("merci", null, 3);
    await h.fire();
    const id = h.posted[0].clientId;
    h.d.undo("merci");
    expect(h.posted[1]).toEqual({ undo: id, day: "2026-11-06" });
  });

  it("Undo while it is on its way takes it back once it lands", async () => {
    const h = desk();
    h.d.commit("merci", null, 3);
    h.d.flush();
    h.d.undo("merci");
    expect(h.posted).toHaveLength(1);
    await h.fire();
    expect(h.posted[1]).toMatchObject({ undo: h.posted[0].clientId });
  });

  it("the same word cannot be sent twice", async () => {
    const h = desk();
    h.d.commit("merci", null, 3);
    h.d.commit("merci", null, 4);
    await h.fire();
    expect(h.posted).toHaveLength(1);
  });

  it("a failure says so and lets him try again", async () => {
    const h = desk();
    h.setFail(true);
    h.d.commit("merci", null, 3);
    await h.fire();
    expect(h.failed).toEqual(["merci"]);
    expect(h.d.has("merci")).toBe(false);
    h.setFail(false);
    h.d.commit("merci", null, 3);
    expect(h.d.has("merci")).toBe(true);
  });

  it("a failed undo says so too", async () => {
    const h = desk();
    h.d.commit("merci", null, 3);
    await h.fire();
    h.setFail(true);
    h.d.undo("merci");
    await h.fire();
    expect(h.failed).toEqual(["merci"]);
  });

  it("leaving sends what he swiped, and only that", async () => {
    const h = desk();
    h.d.commit("merci", null, 3);
    h.d.commit("pain", null, 2);
    h.d.flush();
    h.d.flush();
    expect(h.posted).toHaveLength(2);
  });

  it("an unknown word's undo is nothing", () => {
    const h = desk();
    h.d.undo("absent");
    expect(h.posted).toEqual([]);
    expect(h.d.state("absent")).toBeNull();
  });

  it("uses real timers when given none", async () => {
    const post = mock(async () => ({}));
    const d = createCommits({
      holdMs: 1,
      newId: () => "a",
      day: () => "d",
      post,
      onChange: () => {},
    });
    d.commit("x", null, 3);
    await new Promise((r) => setTimeout(r, 15));
    expect(post).toHaveBeenCalledTimes(1);
    d.commit("y", null, 3);
    d.undo("y");
  });

  it("the page opens words read-only: its gloss asks no model, and no card route but on commit", () => {
    const src = readFileSync("app/(app)/vibe/VibeWords.tsx", "utf8");
    expect(src).toContain("fetchGloss(material, h.w, firstHeard(h.w, lines)?.text ?? null, null)");
    expect(src).not.toContain("make-cards");
    expect(src).toContain("onCommit={(r) => desk.commit(");
    // onPreview and the rest of the strip's events do nothing here.
    expect(src).toContain("onPreview={() => {}}");
  });
});
