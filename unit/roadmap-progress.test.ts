import { describe, expect, it } from "bun:test";
import { roadmapProgress } from "@/lib/roadmap/progress";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { RoadmapNode } from "@/types/roadmap";

const node = (i: number, keywords: string[]): RoadmapNode => ({
  id: `n${i}`,
  title: `Step ${i}`,
  description: "",
  keywords,
  order: i,
});

describe("roadmapProgress", () => {
  it("counts a card toward every step whose keyword is in its url or title", () => {
    const { nodes, overallMaturityRate } = roadmapProgress(
      [node(0, ["Kanji"]), node(1, ["grammar"])],
      [
        { url: "https://x/kanji-1", state: 2, stability: 30 },
        { url: "https://x/a", title: "N3 Grammar and kanji", state: 1, stability: 2 },
        { url: "https://x/other", state: 2, stability: 40 },
      ],
    );
    expect(nodes.map((n) => [n.totalCards, n.matureCards])).toEqual([
      [2, 1],
      [1, 0],
    ]);
    expect(nodes[0].maturityRate).toBe(0.5);
    expect(overallMaturityRate).toBeCloseTo(1 / 3);
  });

  it("skips a note without a card instead of throwing (the detail-pane bug)", () => {
    const { nodes } = roadmapProgress(
      [node(0, ["video"])],
      [{ url: "https://x/video-with-speed-markers-only" }],
    );
    expect(nodes[0].totalCards).toBe(0);
    expect(nodes[0].maturityRate).toBe(0);
  });

  it("is 0% with no cards and keeps the steps as given", () => {
    const steps = Array.from({ length: 20 }, (_, i) => node(i, [`kw${i}`]));
    const r = roadmapProgress(steps, []);
    expect(r.nodes).toHaveLength(20);
    expect(r.overallMaturityRate).toBe(0);
  });

  it("ignores an empty keyword rather than matching every card", () => {
    const { nodes } = roadmapProgress([node(0, [""])], [{ url: "https://x/a", state: 2 }]);
    expect(nodes[0].totalCards).toBe(0);
  });
});

describe("FsrsNotesD1Repo.listCardStats", () => {
  it("returns url, title, state and stability; cardless and deleted notes stay readable", async () => {
    const db = new TestD1Database();
    await db.exec(testSchema());
    const ins = (id: string, url: string, card: string | null, deleted: string | null = null) =>
      db
        .prepare(
          "INSERT INTO fsrs_notes (id,email,url,title,card,log,card_due,deleted_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(id, "a@x", url, "T", card ?? "null", "[]", "2026-01-01T00:00:00.000Z", deleted)
        .run();
    await ins("1", "https://x/1", JSON.stringify({ state: 2, stability: 25.5 }));
    await ins("2", "https://x/2", null);
    await ins("3", "https://x/3", JSON.stringify({ state: 2, stability: 1 }), "2026-01-02");
    const stats = await new FsrsNotesD1Repo(db as never, "a@x").listCardStats();
    expect(stats.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: "https://x/1", title: "T", state: 2, stability: 25.5 },
      { url: "https://x/2", title: "T", state: undefined, stability: undefined },
    ]);
  });
});
