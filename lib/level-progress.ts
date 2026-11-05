/**
 * What the learner-level UI shows (docs/levels.md, "Showing it"): who sees a
 * level (the `levels` flag, the owner while it is off), and the "what next"
 * line under the badge on /profile. Client-safe: no D1.
 */
import { flagIn, type FlagValues } from "@/lib/flags";
import { LEVELS, levelById, type LevelId, type LevelTier } from "@/lib/levels";

/** Levels are shown to everyone once `levels` is on; to the owner only while it is off. */
export function levelsOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return flagIn(flags, "levels") || owner;
}

/** The fields of `UserLevel` (lib/study-days.ts) the UI reads. */
export type LevelView = {
  level: LevelId;
  tier: LevelTier;
  studyDays: number;
  next: { level: LevelId; studyDays: number } | null;
};

/**
 * The next step, from the data alone:
 * - `signup` — a guest: an account reaches the next level;
 * - `pro` — a free account: paying reaches the next level;
 * - `days` — paid: `days` more study days reach `next`;
 * - `top` — the last level.
 */
export type LevelProgress =
  | { kind: "signup"; next: LevelId }
  | { kind: "pro"; next: LevelId }
  | { kind: "days"; next: LevelId; days: number }
  | { kind: "top" };

export function levelProgress(v: LevelView): LevelProgress {
  const at = levelById(v.level);
  const after = LEVELS.find((l) => l.rank === at.rank + 1);
  if (!after) return { kind: "top" };
  if (v.tier === "guest") return { kind: "signup", next: after.id };
  if (v.tier === "free") return { kind: "pro", next: after.id };
  const next = v.next ?? { level: after.id, studyDays: after.studyDays ?? 0 };
  return { kind: "days", next: next.level, days: Math.max(1, next.studyDays - v.studyDays) };
}

/** The strings `progressText` fills in (dictionary `learner-level-ui`). */
export type ProgressLabels = {
  daysToNextOne: string;
  daysToNextOther: string;
  signUpToNext: string;
  proToNext: string;
  top: string;
};

/** The progress line, `{n}` and `{level}` filled in; plural form by `Intl.PluralRules`. */
export function progressText(
  p: LevelProgress,
  labels: ProgressLabels,
  names: Record<LevelId, string>,
  locale: string,
): string {
  if (p.kind === "top") return labels.top;
  const level = names[p.next];
  if (p.kind === "signup") return labels.signUpToNext.replace("{level}", level);
  if (p.kind === "pro") return labels.proToNext.replace("{level}", level);
  let one = false;
  try {
    one = new Intl.PluralRules(locale).select(p.days) === "one";
  } catch {
    one = p.days === 1;
  }
  return (one ? labels.daysToNextOne : labels.daysToNextOther)
    .replace("{n}", p.days.toLocaleString(locale))
    .replace("{level}", level);
}

/** Levels above the user's: drawn faint (locked) on the ladder. */
export function isLocked(level: LevelId, at: LevelId): boolean {
  return levelById(level).rank > levelById(at).rank;
}
