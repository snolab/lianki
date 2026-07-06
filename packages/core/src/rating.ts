import { type Grade, Rating } from "ts-fsrs";

/** Maps userscript rating tokens (name or 1-4) to ts-fsrs Grades. */
export const RATING_MAP: Record<string, Grade> = {
  "1": Rating.Again,
  again: Rating.Again,
  "2": Rating.Hard,
  hard: Rating.Hard,
  "3": Rating.Good,
  good: Rating.Good,
  "4": Rating.Easy,
  easy: Rating.Easy,
};
