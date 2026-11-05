/**
 * Learner levels (docs/levels.md). One set of level ids for every locale;
 * only the names differ, as per-locale data in
 * app/components/level-badge.content.ts ("learner-levels"):
 *
 *   zh / ja / ko  a xianxia cultivation ladder  炼气 → 筑基 → 金丹 → 元婴 → 化神 → 炼虚
 *   every other   a lotus-growth ladder         Seed → Root → Stem → Bud → Bloom → Lotus
 *
 * The badge (app/components/level-badge.tsx) draws the lotus stage for both:
 * a lotus rising through stages reads as cultivation too.
 *
 * The ladder doubles as the membership ladder (owner, Slack 2026-11-05):
 * lv1 is using Lianki without an account, lv2 a signed-in free account, lv3
 * the entry level on paying, and lv4–lv6 are unlocked one by one by learning
 * progress after paying: cumulative study days counted from the first paid
 * day (not a streak — gaps don't reset): 100 for lv4, 365 for lv5, 1000 for
 * lv6 (owner, Slack 2026-11-05). Nothing user-facing reads this yet.
 */

export const LEVEL_IDS = ["lv1", "lv2", "lv3", "lv4", "lv5", "lv6"] as const;
export type LevelId = (typeof LEVEL_IDS)[number];

/** What the badge draws, in growth order. */
export type LotusStage = "seed" | "root" | "stem" | "bud" | "bloom" | "lotus";

/** guest = no account; free = signed in, not paying; paid = paying. */
export type LevelTier = "guest" | "free" | "paid";

/**
 * How a level is reached: `tier` — by being in that membership tier;
 * `progress` — by cumulative study days inside the paid tier.
 */
export type LevelUnlock = "tier" | "progress";

export type Level = {
  id: LevelId;
  /** 1-based rank, for ordering and "level n" labels. */
  rank: number;
  stage: LotusStage;
  tier: LevelTier;
  unlock: LevelUnlock;
  /** For `unlock: "progress"`: cumulative study days since the first paid day. */
  studyDays?: number;
};

export const LEVELS: readonly Level[] = [
  { id: "lv1", rank: 1, stage: "seed", tier: "guest", unlock: "tier" },
  { id: "lv2", rank: 2, stage: "root", tier: "free", unlock: "tier" },
  { id: "lv3", rank: 3, stage: "stem", tier: "paid", unlock: "tier" },
  { id: "lv4", rank: 4, stage: "bud", tier: "paid", unlock: "progress", studyDays: 100 },
  { id: "lv5", rank: 5, stage: "bloom", tier: "paid", unlock: "progress", studyDays: 365 },
  { id: "lv6", rank: 6, stage: "lotus", tier: "paid", unlock: "progress", studyDays: 1000 },
];

export function levelById(id: LevelId): Level {
  return LEVELS.find((l) => l.id === id)!;
}

/** Which ladder a locale's level names come from. */
export type LevelLadder = "cultivation" | "lotus";

const CULTIVATION_LOCALES = new Set(["zh", "ja", "ko"]);

export function ladderFor(locale: string): LevelLadder {
  return CULTIVATION_LOCALES.has(locale.toLowerCase().split(/[-_]/)[0]) ? "cultivation" : "lotus";
}
