import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LevelBadge } from "@/app/components/level-badge";
import names from "@/app/components/level-badge.content";
import { LEVEL_IDS, LEVELS, ladderFor, levelById } from "@/lib/levels";

describe("learner levels (docs/levels.md)", () => {
  it("lists six levels in rank order, one per id", () => {
    expect(LEVELS.map((l) => l.id)).toEqual([...LEVEL_IDS]);
    expect(LEVELS.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(levelById("lv4").stage).toBe("bud");
  });

  it("is the membership ladder: guest, free, paid, then study days", () => {
    expect(LEVELS.map((l) => l.tier)).toEqual(["guest", "free", "paid", "paid", "paid", "paid"]);
    expect(LEVELS.map((l) => l.studyDays ?? null)).toEqual([null, null, null, 100, 365, 1000]);
    for (const l of LEVELS) expect(l.unlock).toBe(l.studyDays ? "progress" : "tier");
  });

  it("names zh / ja / ko from the cultivation ladder, the rest from the lotus", () => {
    expect(["zh", "ja", "ko", "zh-TW", "ja_JP"].map(ladderFor)).toEqual(
      Array(5).fill("cultivation"),
    );
    expect(["en", "fr", "hi", "sw"].map(ladderFor)).toEqual(Array(4).fill("lotus"));
    const tr = (id: string, l: string) =>
      (names.content as Record<string, { translation: Record<string, string> }>)[id].translation[l];
    expect(tr("lv1", "zh")).toBe("炼气");
    expect(tr("lv1", "en")).toBe("Seed");
    expect(tr("lv6", "en")).toBe("Lotus");
  });

  it("draws a badge per level, seal red only when unlocked, no text inside", () => {
    for (const id of LEVEL_IDS) {
      const on = renderToStaticMarkup(createElement(LevelBadge, { level: id, size: 20 }));
      const off = renderToStaticMarkup(createElement(LevelBadge, { level: id, locked: true }));
      expect(on).toContain('width="20"');
      expect(on).toContain("--lk-badge-seal");
      expect(off).not.toContain("--lk-badge-seal");
      expect(off).toContain('data-locked="true"');
      expect(on).not.toContain("<text");
      expect(on).toContain('aria-hidden="true"');
    }
    const named = renderToStaticMarkup(createElement(LevelBadge, { level: "lv2", label: "Root" }));
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Root"');
  });
});
