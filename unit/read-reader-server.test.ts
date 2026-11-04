import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  blocksFromItems,
  GRADE_HOLD_MS,
  itemGrade,
  serverReaderData,
} from "@/lib/read/reader-server";
import type { Familiarity, ItemsResponse, SentenceState } from "@/lib/read/reader-api";

const H = "0123456789abcdef";
const fam = (value: number): Familiarity => ({
  tokens: 1,
  vocab: value,
  coverage: value,
  grade: 0,
  understood: 0,
  graded: 0,
  value,
});
const state = (r: 1 | 2 | 3 | 4, at: string): SentenceState => ({
  due: at,
  stability: 1,
  reps: 1,
  lapses: 0,
  state: 2,
  lastRating: r,
  lastAt: at,
});
// Line 0 heading; line 1 two sentences split over two items; line 2 one sentence.
const res: Pick<ItemsResponse, "items" | "bookHash" | "cards"> = {
  bookHash: H,
  items: [
    {
      key: "a",
      sentences: [[1, 0, 0, 4]],
      chapter: 0,
      words: 1,
      seconds: 1,
      fam: fam(0.2),
      due: null,
    },
    {
      key: "b",
      sentences: [
        [1, 1, 5, 9],
        [2, 0, 0, 6],
      ],
      chapter: 0,
      words: 2,
      seconds: 2,
      fam: fam(0.9),
      due: null,
    },
  ],
  cards: {
    [`${H}:1.1`]: state(2, "2026-11-01T00:00:00Z"),
    [`${H}:2.0`]: state(4, "2026-11-02T00:00:00Z"),
  },
};

describe("reader v2 from the server", () => {
  it("turns items into blocks with the server's cuts, headings in order", () => {
    const out = blocksFromItems(res, new Set([0]), 3);
    expect(out.blocks).toEqual([
      { kind: "heading", line: 0 },
      { kind: "item", id: "a", pieces: [{ line: 1, s0: 0, s1: 1 }], fam: 0.2 },
      {
        kind: "item",
        id: "b",
        pieces: [
          { line: 1, s0: 1, s1: -1 },
          { line: 2, s0: 0, s1: -1 },
        ],
        fam: 0.9,
      },
    ]);
    expect(out.cuts.get(1)).toEqual([
      [0, 4],
      [5, 9],
    ]);
    expect(out.sids.get("b")).toEqual([`${H}:1.1`, `${H}:2.0`]);
    expect(out.grades).toEqual({ b: 4 });
  });

  it("gives an item the latest of its sentences' grades", () => {
    expect(itemGrade(res.items[1], H, res.cards)).toBe(4);
    expect(itemGrade(res.items[0], H, res.cards)).toBeNull();
  });
});

describe("server reader data", () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    calls.length = 0;
  });
  const fake = (body: unknown) =>
    (globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch);
  const book = {
    id: "m1",
    lines: ["T", "One. Two.", "Three."],
    headings: new Set([0]),
    chapterStarts: new Set([0]),
    lang: "en",
  };

  it("holds a grade for Undo, then sends it once", async () => {
    fake({
      ...res,
      lang: "en",
      granularity: "paragraph",
      chapters: [0],
      lines: [0, 3],
      bounds: {},
    });
    const d = serverReaderData("m1", H);
    const l = await d.load(book);
    expect(calls[0].url).toBe("/api/read/m1/items?g=paragraph&from=0&to=3");
    const item = l.blocks[2];
    if (item.kind !== "item") throw new Error("item");
    const r = await d.grade(book, item, 3, { shownAt: 1 });
    expect(d.canUndo(r)).toBe(true);
    await d.undo(book, r);
    expect(d.canUndo(r)).toBe(false);
    expect(d.lastGrade("b")).toBe(4);
    expect(calls.length).toBe(1);
    const r2 = await d.grade(book, item, 1);
    d.flush();
    expect(d.canUndo(r2)).toBe(false);
    expect(calls.length).toBe(2);
    const sent = JSON.parse(String(calls[1].init?.body));
    expect(sent).toMatchObject({
      sentences: [`${H}:1.1`, `${H}:2.0`],
      rating: 1,
      granularity: "paragraph",
    });
    expect(typeof sent.clientId).toBe("string");
    expect(GRADE_HOLD_MS).toBeGreaterThan(0);
    // Progress: the graded item's last line is the high-water mark.
    d.saveAnchor("m1", { line: 1, off: 0.5, at: 0 });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      line: 1,
      offset: 0.5,
      highLine: 2,
    });
  });

  it("revert: a held grade is dropped; a sent one is taken back by the server", async () => {
    fake({
      ...res,
      lang: "en",
      granularity: "paragraph",
      chapters: [0],
      lines: [0, 3],
      bounds: {},
    });
    const d = serverReaderData("m1", H);
    const l = await d.load(book);
    const item = l.blocks[2];
    if (item.kind !== "item") throw new Error("item");
    const held = await d.grade(book, item, 2);
    await d.revert(book, held);
    expect(calls.length).toBe(1);
    const sent = await d.grade(book, item, 1);
    d.flush();
    expect(calls.length).toBe(2);
    await d.revert(book, sent);
    expect(calls[2].url).toBe("/api/read/m1/batch-grade");
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ undo: sent.clientId });
    expect(d.lastGrade("b")).toBe(4);
  });

  it("takes the newer of the synced and the device's position", async () => {
    fake({ anchor: { line: 7, offset: 0.25, at: "2026-11-03T00:00:00Z" }, highLine: 5 });
    const d = serverReaderData("m1", H);
    expect(await d.anchor("m1")).toEqual({
      line: 7,
      off: 0.25,
      at: Date.parse("2026-11-03T00:00:00Z"),
    });
  });

  it("falls back to the device's copy, and beacons on leaving", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 500 }),
    ) as unknown as typeof fetch;
    const d = serverReaderData("m1", H);
    expect(await d.anchor("m1")).toBeNull();
    globalThis.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await d.anchor("m1")).toBeNull();
    const beacons: string[] = [];
    const nav = globalThis.navigator as unknown as { sendBeacon?: unknown };
    const had = nav.sendBeacon;
    nav.sendBeacon = (url: string) => (beacons.push(url), true);
    d.saveAnchor("m1", { line: 2, off: 0, at: 0 }, { leaving: true });
    nav.sendBeacon = had;
    expect(beacons).toEqual(["/api/read/m1/progress"]);
    d.saveAnchor("m1", { line: 2, off: 0, at: 0 });
  });

  it("local data: always undoable, nothing to flush", async () => {
    const { localReaderData } = await import("@/lib/read/reader-adapter");
    const d = localReaderData();
    expect(d.canUndo({ itemId: "x", rating: 3, at: 0 })).toBe(true);
    d.flush();
  });

  it("keeps a grade the server refused, to send again", async () => {
    fake({
      ...res,
      lang: "en",
      granularity: "paragraph",
      chapters: [0],
      lines: [0, 3],
      bounds: {},
    });
    const d = serverReaderData("m1", H);
    const l = await d.load(book);
    const item = l.blocks[1];
    if (item.kind !== "item") throw new Error("item");
    globalThis.fetch = mock(
      async () => new Response("", { status: 503 }),
    ) as unknown as typeof fetch;
    const r = await d.grade(book, item, 2);
    d.flush();
    await new Promise((ok) => setTimeout(ok, 5));
    // Sent (no longer undoable) but not lost: a later flush sends it again.
    expect(d.canUndo(r)).toBe(false);
    let again = 0;
    globalThis.fetch = mock(async () => (again++, new Response("{}"))) as unknown as typeof fetch;
    d.flush();
    await new Promise((ok) => setTimeout(ok, 5));
    expect(again).toBe(1);
  });

  it("keeps sent-but-unacknowledged grades on the device and replays them on the next open", async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as { localStorage?: unknown };
    const had = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    try {
      fake({
        ...res,
        lang: "en",
        granularity: "paragraph",
        chapters: [0],
        lines: [0, 3],
        bounds: {},
      });
      const d = serverReaderData("m1", H);
      const item = (await d.load(book)).blocks[1];
      if (item.kind !== "item") throw new Error("item");
      globalThis.fetch = mock(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      await d.grade(book, item, 3);
      d.flush();
      await new Promise((ok) => setTimeout(ok, 5));
      expect(JSON.parse(store.get("lk:read-unsent") ?? "[]").length).toBe(1);
      // The next open sends it, and the outbox empties.
      fake({
        ...res,
        lang: "en",
        granularity: "paragraph",
        chapters: [0],
        lines: [0, 3],
        bounds: {},
      });
      await serverReaderData("m1", H).load(book);
      await new Promise((ok) => setTimeout(ok, 5));
      expect(calls.some((c) => c.url.endsWith("/grade"))).toBe(true);
      expect(store.has("lk:read-unsent")).toBe(false);
    } finally {
      g.localStorage = had;
    }
  });

  it("an outbox that cannot be read or written never breaks grading", async () => {
    const g = globalThis as unknown as { localStorage?: unknown };
    const had = g.localStorage;
    const boom = () => {
      throw new Error("denied");
    };
    g.localStorage = { getItem: () => "not json", setItem: boom, removeItem: boom };
    try {
      fake({
        ...res,
        lang: "en",
        granularity: "paragraph",
        chapters: [0],
        lines: [0, 3],
        bounds: {},
      });
      const d = serverReaderData("m1", H);
      const item = (await d.load(book)).blocks[1];
      if (item.kind !== "item") throw new Error("item");
      await d.grade(book, item, 4);
      d.flush();
      await new Promise((ok) => setTimeout(ok, 5));
      expect(calls.some((c) => c.url.endsWith("/grade"))).toBe(true);
    } finally {
      g.localStorage = had;
    }
  });

  it("sends a grade by itself once the Undo window is over, retrying a failure", async () => {
    fake({
      ...res,
      lang: "en",
      granularity: "paragraph",
      chapters: [0],
      lines: [0, 3],
      bounds: {},
    });
    const d = serverReaderData("m1", H, 2);
    const item = (await d.load(book)).blocks[1];
    if (item.kind !== "item") throw new Error("item");
    let n = 0;
    globalThis.fetch = mock(async (url: string | URL) => {
      if (String(url).endsWith("/progress")) throw new Error("offline");
      return new Response("{}", { status: n++ ? 200 : 503 });
    }) as unknown as typeof fetch;
    await d.grade(book, item, 3);
    await new Promise((ok) => setTimeout(ok, 30));
    expect(n).toBe(2);
    d.saveAnchor("m1", { line: 1, off: 0, at: 0 });
    await new Promise((ok) => setTimeout(ok, 5));
  });
});
