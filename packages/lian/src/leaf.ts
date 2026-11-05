/**
 * Study-day leaves: one per user per day.
 *
 *   leaf = H(canonical(["lian/study-day/1", salt, userId, day, summary]))
 *
 * `salt` is the user's own random secret (kept server-side, handed only to
 * that user), so a published leaf says nothing about who studied or how much:
 * without the salt nobody can test a guess. `summary` is the counts the
 * study-day rule already keeps (lib/study-days.ts) — never card content.
 */
import { isDay } from "./chain";
import { entryHash } from "./encode";

export const STUDY_DAY_TAG = "lian/study-day/1";

export type StudySummary = { reviews: number };

export type StudyDayPreimage = {
  tag: typeof STUDY_DAY_TAG;
  salt: string;
  userId: string;
  day: string;
  summary: StudySummary;
};

export function studyDayPreimage(
  salt: string,
  userId: string,
  day: string,
  summary: StudySummary,
): StudyDayPreimage {
  if (!/^[0-9a-f]{32,}$/.test(salt)) throw new Error("lian: a salt is at least 16 random bytes");
  if (!userId) throw new Error("lian: no user id");
  if (!isDay(day)) throw new Error("lian: not a day");
  if (!Number.isSafeInteger(summary.reviews) || summary.reviews < 0)
    throw new Error("lian: reviews is a count");
  return { tag: STUDY_DAY_TAG, salt, userId, day, summary: { reviews: summary.reviews } };
}

export function studyDayLeaf(p: StudyDayPreimage): Promise<string> {
  return entryHash([p.tag, p.salt, p.userId, p.day, { reviews: p.summary.reviews }]);
}
