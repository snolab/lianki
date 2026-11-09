import { describe, expect, it } from "bun:test";
import { countLabel, fill } from "@/lib/roadmap/labels";
import roadmapPage from "@/app/(app)/roadmap/page.content";

type Leaf = { translation: Record<string, string> };
const tr = (k: keyof typeof roadmapPage.content) =>
  (roadmapPage.content[k] as unknown as Leaf).translation;

describe("roadmap labels", () => {
  it("fills named placeholders and leaves unknown ones", () => {
    expect(fill("{mature}/{total} cards", { mature: 3, total: 10 })).toBe("3/10 cards");
    expect(fill("{pct}% {x}", { pct: 40 })).toBe("40% {x}");
  });

  it("picks the singular by the locale's plural rules", () => {
    const one = tr("stepsOne");
    const other = tr("stepsOther");
    expect(countLabel("en", 1, one.en, other.en)).toBe("1 step");
    expect(countLabel("en", 20, one.en, other.en)).toBe("20 steps");
    // ru "one" covers 21 too ("21 шаг"); 2–4 and 5–20 take the label form.
    expect(countLabel("ru", 21, one.ru, other.ru)).toBe("21 шаг");
    expect(countLabel("ru", 3, one.ru, other.ru)).toBe("Шагов: 3");
    expect(countLabel("zh", 20, one.zh, other.zh)).toBe("20 步");
    expect(countLabel("ar", 1, one.ar, other.ar)).toBe("خطوة واحدة");
  });

  it("names the page just 'Roadmap' (owner, 2026-11-07)", () => {
    expect(tr("heading").en).toBe("Roadmap");
    expect(tr("heading").zh).toBe("路线图");
    expect(tr("wishPlaceholder").zh).toBe("你的愿望");
    for (const v of Object.values(tr("heading"))) expect(v).not.toMatch(/\bAI\b|Learning/);
  });

  it("has all 16 locales on every key, and keeps the placeholders", () => {
    for (const k of Object.keys(roadmapPage.content) as (keyof typeof roadmapPage.content)[]) {
      if (k === "metadata") continue;
      const t = tr(k);
      expect(Object.keys(t)).toHaveLength(16);
      const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      for (const [loc, v] of Object.entries(t)) {
        // ar's singular spells the number out ("one step"), so it carries no {n}.
        if (k === "stepsOne" && loc === "ar") continue;
        expect([loc, holes(v)]).toEqual([loc, holes(t.en)]);
      }
    }
  });
});
