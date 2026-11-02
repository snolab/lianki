import { describe, expect, test } from "bun:test";
import {
  bucketByLanguage,
  integerWeights,
  nextLeaf,
  type NodeOrder,
  type OrderNode,
  planNew,
  resolveOrders,
  seenOf,
  stridePattern,
  tally,
} from "@/lib/words/new-order";

// docs/new-word-scheduler.md, section 7. Defaults: a group goes in order and
// opens the next list when the one before passes (60% progress); the root
// takes turns. A leaf is L(id, words, seen, progress score sum).
const L = (id: string, size: number, seen = 0, score = 0, extra: Partial<OrderNode> = {}) =>
  ({ id, size, seen, score, ...extra }) as OrderNode;
const G = (id: string, children: OrderNode[], order?: NodeOrder) =>
  ({ id, children, order }) as OrderNode;
const root = (children: OrderNode[], order?: NodeOrder) => G("root", children, order);
const plan = (r: OrderNode, n: number) => planNew(r, n).join(" ");
const shares = (r: OrderNode, n: number) => Object.fromEntries(tally(planNew(r, n)));

describe("new-word order", () => {
  test("1. the root takes turns between languages; inside one, only N5 is open", () => {
    const r = root([G("ja", [L("N5", 800), L("N4", 600)]), G("fr", [L("A1", 500)])]);
    expect(plan(r, 8)).toBe("N5 A1 N5 A1 N5 A1 N5 A1");
  });

  test("2a. N5 at 59% progress has not passed: N4 stays closed", () => {
    const r = root([G("ja", [L("N5", 1000, 998, 590), L("N4", 600)])]);
    expect(plan(r, 4)).toBe("N5 N5");
  });

  test("2b. N5 at 60% passes: N4 opens, but in order N5's own words still come first", () => {
    const r = root([G("ja", [L("N5", 1000, 998, 600), L("N4", 600)])]);
    expect(plan(r, 4)).toBe("N5 N5 N4 N4");
  });

  test("2c. every N5 word seen but not passed: Japanese gives no new word; French goes on", () => {
    expect(planNew(root([G("ja", [L("N5", 1000, 1000, 500), L("N4", 600)])]), 3)).toEqual([]);
    const both = root([G("ja", [L("N5", 1000, 1000, 500), L("N4", 600)]), G("fr", [L("A1", 500)])]);
    expect(plan(both, 3)).toBe("A1 A1 A1");
  });

  test("2d. passing through reviews opens N4 at the very next new word", () => {
    const r = root([G("ja", [L("N5", 1000, 1000, 599), L("N4", 600)])]);
    expect(nextLeaf(r)).toBeNull();
    r.children![0].children![0].score = 600; // a review raised N5's progress to 60%
    expect(nextLeaf(r)!.id).toBe("N4");
  });

  test("3. staggered: once N5 passes, N5 and N4 share 2:1", () => {
    const r = root([G("ja", [L("N5", 1000, 900, 600), L("N4", 600)], { mode: "stagger" })]);
    expect(plan(r, 6)).toBe("N5 N5 N4 N5 N5 N4");
  });

  test("3b. staggered, three open (80%, 65%, 10%) share 4:2:1; the fourth waits", () => {
    const r = root([
      G(
        "ja",
        [L("N5", 800, 700, 640), L("N4", 600, 500, 390), L("N3", 600, 100, 60), L("N2", 1000)],
        { mode: "stagger" },
      ),
    ]);
    expect(shares(r, 14)).toEqual({ N5: 8, N4: 4, N3: 2 });
  });

  test("4. a passed, finished level drops out; in order, the next level gives every word", () => {
    const r = root([G("ja", [L("N5", 800, 800, 800), L("N4", 600, 420, 420), L("N3", 600)])]);
    expect(plan(r, 6)).toBe("N4 N4 N4 N4 N4 N4");
  });

  test("5. long stream, staggered: the first 300 after N5 passes are 200 / 100", () => {
    const r = root([G("ja", [L("N5", 1000, 700, 600), L("N4", 600)], { mode: "stagger" })]);
    expect(shares(r, 300)).toEqual({ N5: 200, N4: 100 });
  });

  test("6. long stream, defaults: Japanese and French half each; N4 none until N5 passes", () => {
    const r = root([G("ja", [L("N5", 1000, 100, 10), L("N4", 600)]), G("fr", [L("A1", 500)])]);
    expect(shares(r, 300)).toEqual({ N5: 150, A1: 150 });
  });

  test("7. by weight, 3:1", () => {
    const r = root([
      G("x", [L("A", 100, 0, 0, { weight: 3 }), L("B", 100, 0, 0, { weight: 1 })], {
        mode: "weighted",
      }),
    ]);
    expect(plan(r, 8)).toBe("A A A B A A A B");
  });

  test("8. by weight: 0 pauses a list; take turns ignores weights", () => {
    const kids = () => [L("A", 100, 0, 0, { weight: 0 }), L("B", 100)];
    expect(plan(root([G("x", kids(), { mode: "weighted" })]), 4)).toBe("B B B B");
    expect(plan(root([G("x", kids(), { mode: "rr" })]), 4)).toBe("A B A B");
  });

  test("9. a list studied on its own shifts the turn, with no catch-up burst", () => {
    const r = root([G("ja", [L("N5", 800, 5)]), G("fr", [L("A1", 500)])]);
    expect(plan(r, 8)).toBe("A1 N5 A1 N5 A1 N5 A1 N5");
  });

  test("10. staggered with ratio 3: the older level gets three times the share", () => {
    const r = root([
      G("ja", [L("N5", 1000, 700, 600), L("N4", 600)], { mode: "stagger", ratio: 3 }),
    ]);
    expect(plan(r, 8)).toBe("N5 N5 N5 N4 N5 N5 N5 N4");
  });

  test("11. dragging N4 above N5 makes N5 wait for N4 to pass", () => {
    const r = root([G("ja", [L("N4", 600), L("N5", 1000, 700, 650)])]);
    expect(plan(r, 4)).toBe("N4 N4 N4 N4");
  });

  test("12. stable across a reload: 4 then 6 is the same as 10", () => {
    const mk = () =>
      root([G("ja", [L("N5", 800, 600, 100), L("N4", 600)]), G("fr", [L("A1", 500)])]);
    const full = planNew(mk(), 10);
    const t = mk();
    const seen = seenOf(t);
    const first = planNew(t, 4, seen);
    // The reload: the four were graded, so they are in the stored seen counts.
    const reloaded = mk();
    reloaded.children![0].children![0].seen = seen.get("N5");
    reloaded.children![1].children![0].seen = seen.get("A1");
    expect([...first, ...planNew(reloaded, 6)]).toEqual(full);
    expect(full.join(" ")).toBe("N5 A1 N5 A1 N5 A1 N5 A1 N5 A1");
  });

  test("13. flat root with no language groups: same-language lists bucket together", () => {
    const flat = root([
      L("N5", 800, 0, 0, { lang: "ja" }),
      L("N4", 600, 0, 0, { lang: "ja" }),
      L("A1", 500, 0, 0, { lang: "fr" }),
    ]);
    const b = bucketByLanguage(flat);
    expect(b.children!.map((c) => c.id)).toEqual(["lang:ja", "A1"]);
    expect(plan(b, 6)).toBe("N5 A1 N5 A1 N5 A1");
    // Without buckets the root would take turns between N5 and N4.
    expect(plan(flat, 3)).toBe("N5 N4 A1");
  });

  test("14. children inherit the parent's mode and can override it; the root's is not inherited", () => {
    const r = root(
      [
        G(
          "ja",
          [
            G("jlpt", [L("N5", 10), L("N4", 10)]),
            G("kana", [L("h", 5), L("k", 5)], { mode: "rr" }),
          ],
          { mode: "stagger" },
        ),
      ],
      { mode: "weighted" },
    );
    const o = resolveOrders(r);
    expect(o.get("root")!.mode).toBe("weighted");
    expect(o.get("ja")!.mode).toBe("stagger");
    expect(o.get("jlpt")!.mode).toBe("stagger");
    expect(o.get("kana")!.mode).toBe("rr");
    expect(resolveOrders(root([G("ja", [L("a", 1)])], { mode: "rr" })).get("ja")!.mode).toBe("seq");
  });

  test("15. a lower pass mark set on a parent is inherited by its sub-groups", () => {
    const r = root([G("ja", [G("jlpt", [L("N5", 100, 100, 30), L("N4", 100)])], { passAt: 0.3 })]);
    expect(resolveOrders(r).get("jlpt")!.passAt).toBe(0.3);
    expect(plan(r, 2)).toBe("N4 N4");
  });

  test("16. edge cases: an empty tree and a fully seen tree give nothing", () => {
    expect(planNew(root([]), 5)).toEqual([]);
    expect(nextLeaf(root([G("ja", [L("N5", 3, 3, 3)])]))).toBeNull();
    expect(plan(root([G("ja", [L("N5", 3, 1)])]), 5)).toBe("N5 N5");
  });

  test("stride pattern and integer weights keep the ratios", () => {
    expect(stridePattern([2, 1])).toEqual([0, 0, 1]);
    expect(integerWeights([4, 2, 1])).toEqual([4, 2, 1]);
    expect(integerWeights([2.25, 1.5, 1])).toEqual([9, 6, 4]);
    expect(integerWeights([0, 1])).toEqual([0, 1]);
  });

  test("every mode: never more picks than words left, and the same stream twice", () => {
    for (const mode of ["seq", "rr", "stagger", "weighted"] as const) {
      // N5 passed, N4 not: in seq and stagger N3 stays closed.
      const mk = () =>
        root([G("ja", [L("N5", 30, 30, 20), L("N4", 20, 0, 0), L("N3", 5)], { mode })]);
      const p = planNew(mk(), 1000);
      expect(p.length).toBe(mode === "seq" || mode === "stagger" ? 20 : 25);
      expect(planNew(mk(), 1000)).toEqual(p);
    }
  });
});
