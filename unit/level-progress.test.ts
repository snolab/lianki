import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ui from "@/app/components/level-ui.content";
import levelNames from "@/app/components/level-badge.content";
import { LevelCard, type LevelCardLabels } from "@/app/components/LevelCard";
import { LEVEL_IDS, type LevelId } from "@/lib/levels";
import {
  isLocked,
  levelProgress,
  levelsOn,
  progressText,
  type LevelView,
} from "@/lib/level-progress";

type Leaf = { translation: Record<string, string> };
const labelsIn = (locale: string) =>
  Object.fromEntries(
    Object.entries(ui.content as Record<string, Leaf>).map(([k, v]) => [k, v.translation[locale]]),
  ) as unknown as LevelCardLabels & { chipLabel: string };
const namesIn = (locale: string) =>
  Object.fromEntries(
    LEVEL_IDS.map((id) => [
      id,
      (levelNames.content as Record<string, Leaf>)[id].translation[locale],
    ]),
  ) as Record<LevelId, string>;

const paid = (level: LevelId, studyDays: number, next: LevelView["next"]): LevelView => ({
  level,
  tier: "paid",
  studyDays,
  next,
});
const text = (v: LevelView, locale: string) =>
  progressText(levelProgress(v), labelsIn(locale), namesIn(locale), locale);

describe("levelsOn — the `levels` flag gate", () => {
  it("is off for everyone but the owner while the flag is off", () => {
    expect(levelsOn({}, false)).toBe(false);
    expect(levelsOn(null, false)).toBe(false);
    expect(levelsOn({ levels: false }, false)).toBe(false);
    expect(levelsOn({}, true)).toBe(true);
  });
  it("is on for everyone once the flag is on", () => {
    expect(levelsOn({ levels: true }, false)).toBe(true);
    expect(levelsOn({ levels: true }, true)).toBe(true);
  });
});

describe("levelProgress / progressText", () => {
  it("counts the days left to the next level from the data", () => {
    const v = paid("lv3", 37, { level: "lv4", studyDays: 100 });
    expect(levelProgress(v)).toEqual({ kind: "days", next: "lv4", days: 63 });
    expect(text(v, "zh")).toBe("再学 63 天升到元婴");
    expect(text(v, "en")).toBe("63 more study days to reach Bud");
    expect(text(paid("lv4", 120, { level: "lv5", studyDays: 365 }), "ja")).toBe(
      "あと 245 日学ぶと化神へ",
    );
  });

  it("uses the singular form where the locale has one", () => {
    const v = paid("lv5", 999, { level: "lv6", studyDays: 1000 });
    expect(text(v, "en")).toBe("1 more study day to reach Lotus");
    expect(text(v, "de")).toBe("Noch 1 Lerntag bis Lotus");
    expect(text(v, "zh")).toBe("再学 1 天升到炼虚");
  });

  it("shows a guest the sign-up and a free account Pro as the way up", () => {
    const guest: LevelView = { level: "lv1", tier: "guest", studyDays: 0, next: null };
    const free: LevelView = { level: "lv2", tier: "free", studyDays: 0, next: null };
    expect(levelProgress(guest)).toEqual({ kind: "signup", next: "lv2" });
    expect(levelProgress(free)).toEqual({ kind: "pro", next: "lv3" });
    expect(text(guest, "zh")).toBe("注册即可升到筑基");
    expect(text(free, "en")).toBe("Get Pro to reach Stem");
  });

  it("has nothing further at the top", () => {
    const v = paid("lv6", 1200, null);
    expect(levelProgress(v)).toEqual({ kind: "top" });
    expect(text(v, "en")).toBe("You have reached the highest level");
  });

  it("keeps {n} and {level} in every locale's progress strings", () => {
    for (const locale of Object.keys((ui.content.daysToNextOther as unknown as Leaf).translation)) {
      const l = labelsIn(locale);
      expect(l.daysToNextOther).toContain("{n}");
      for (const k of ["daysToNextOther", "signUpToNext", "proToNext", "chipLabel"] as const)
        expect(l[k]).toContain("{level}");
      expect(l.studyDays).toContain("{n}");
    }
  });
});

describe("LevelCard", () => {
  const render = (v: LevelView, locale = "en") =>
    renderToStaticMarkup(
      createElement(LevelCard, {
        view: v,
        names: namesIn(locale),
        labels: labelsIn(locale),
        locale,
      }),
    );

  it("draws the levels above the user's faint and marks the current one", () => {
    expect(isLocked("lv4", "lv3")).toBe(true);
    expect(isLocked("lv3", "lv3")).toBe(false);
    const html = render(paid("lv3", 37, { level: "lv4", studyDays: 100 }));
    expect(html).toContain('width="96"');
    expect(html.match(/data-locked="true"/g)?.length).toBe(3);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Stem, your level");
    expect(html).toContain("Bud, not reached yet");
    expect(html).toContain("Study days so far: 37");
    expect(html).toContain("63 more study days to reach Bud");
  });

  it("links a guest to sign up and a free account to membership, without a study-day count", () => {
    const g = render({ level: "lv1", tier: "guest", studyDays: 0, next: null }, "zh");
    expect(g).toContain('href="/sign-in"');
    expect(g).toContain("炼气");
    expect(g).not.toContain("已学习天数");
    const f = render({ level: "lv2", tier: "free", studyDays: 0, next: null });
    expect(f).toContain('href="/membership"');
  });
});
