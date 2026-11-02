import { describe, expect, test } from "bun:test";
import { newScan, takeNewIndices, type CheckKnown } from "@/lib/words/take-new";

const catalog = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);
/** A server that knows which terms have cards. */
const server = (carded: Set<string>) => {
  const calls: number[] = [];
  const check: CheckKnown = async (terms) => {
    calls.push(terms.length);
    return new Set(terms.filter((t) => carded.has(t)));
  };
  return { check, calls };
};

describe("takeNewIndices", () => {
  test("takes the next uncarded words in catalog order", async () => {
    const terms = catalog(100);
    const { check } = server(new Set(["w1", "w3"]));
    const scan = newScan(0);
    expect(await takeNewIndices(terms, scan, 4, check)).toEqual([0, 2, 4, 5]);
  });

  test("the cursor stops after the last word taken, so no word is skipped", async () => {
    const terms = catalog(200);
    const { check } = server(new Set());
    const scan = newScan(0);
    // One check covers 2n words; only n are taken.
    expect(await takeNewIndices(terms, scan, 20, check)).toEqual([...Array(20).keys()]);
    expect(scan.next).toBe(20);
    // The next batch starts right after: words 20..39, not 40.
    const next = await takeNewIndices(terms, scan, 20, check);
    expect(next[0]).toBe(20);
    // Grading everything taken then saves cursor = scan.next: nothing lost.
    expect(scan.next).toBe(40);
  });

  test("a list whose stored cursor is at the end but has uncarded words offers them (the N5 bug)", async () => {
    // The owner's N5: 710 words, cursor 710, but words 50..249 never got a card.
    const terms = catalog(710);
    const carded = new Set(terms.filter((_, i) => i < 50 || i >= 250));
    const { check } = server(carded);
    const scan = newScan(710);
    const got = await takeNewIndices(terms, scan, 80, check);
    expect(got.length).toBe(80);
    expect(got[0]).toBe(50);
    // The cursor saved now points at the gap again.
    expect(scan.next).toBeLessThanOrEqual(130);
  });

  test("a list with unseen words never comes back empty", async () => {
    const terms = catalog(300);
    for (const cursor of [0, 1, 37, 150, 299, 300]) {
      // One unseen word anywhere: it must be found.
      for (const gap of [0, 42, 149, 150, 299]) {
        const carded = new Set(terms.filter((_, i) => i !== gap));
        const { check } = server(carded);
        const scan = newScan(cursor);
        expect(await takeNewIndices(terms, scan, 40, check)).toEqual([gap]);
      }
    }
  });

  test("truly finished: empty, and stays empty without more checks", async () => {
    const terms = catalog(120);
    const { check, calls } = server(new Set(terms));
    const scan = newScan(120);
    expect(await takeNewIndices(terms, scan, 40, check)).toEqual([]);
    const n = calls.length;
    expect(await takeNewIndices(terms, scan, 40, check)).toEqual([]);
    expect(calls.length).toBe(n);
  });

  test("the re-scan does not repeat words the first pass already took", async () => {
    const terms = catalog(100);
    const { check } = server(new Set());
    const scan = newScan(90);
    const first = await takeNewIndices(terms, scan, 10, check);
    expect(first).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
    // Not graded yet, so the server still has no cards; the re-scan covers 0..89 only.
    const all: number[] = [];
    for (let i = 0; i < 20; i++) all.push(...(await takeNewIndices(terms, scan, 10, check)));
    expect(all).toEqual([...Array(90).keys()]);
  });

  test("offline: the first pass trusts the cursor; the re-scan waits for the network", async () => {
    const terms = catalog(50);
    const offline: CheckKnown = async () => null;
    const scan = newScan(45);
    expect(await takeNewIndices(terms, scan, 10, offline)).toEqual([45, 46, 47, 48, 49]);
    expect(scan.done).toBe(false);
    // Back online: the re-scan runs.
    const { check } = server(new Set(terms.slice(0, 10)));
    expect((await takeNewIndices(terms, scan, 3, check))[0]).toBe(10);
  });

  test("a failed check throws and loses nothing", async () => {
    const terms = catalog(100);
    const scan = newScan(0);
    const broken: CheckKnown = async () => {
      throw new Error("500");
    };
    await expect(takeNewIndices(terms, scan, 10, broken)).rejects.toThrow("500");
    expect(scan.next).toBe(0);
  });
});
