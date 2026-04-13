import { type Card, createEmptyCard, State } from "ts-fsrs";

export function ankiToFSRSState(ankiType: number, ankiQueue: number): State {
  if (ankiType === 0 || ankiQueue === -1) return State.New;
  if (ankiType === 1 || ankiQueue === 0 || ankiQueue === 2) return State.Learning;
  if (ankiType === 3) return State.Relearning;
  return State.Review;
}

export function convertAnkiCard(progress: {
  type: number;
  queue: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  due: number;
}): Card {
  const card = createEmptyCard();
  const state = ankiToFSRSState(progress.type, progress.queue);

  card.state = state;
  card.reps = progress.reps;
  card.lapses = progress.lapses;

  if (state !== State.New && progress.factor > 0) {
    // Difficulty from Anki ease factor (1300-3600 range, default 2500)
    card.difficulty = 1 - Math.max(0, Math.min(1, (progress.factor - 1300) / 1200));

    // Stability from interval + ease + reps
    const interval = Math.max(1, progress.ivl);
    const easeFactor = progress.factor / 2500;
    card.stability = Math.max(1, interval * (0.5 + easeFactor) * Math.log2(progress.reps + 1));

    // Due date based on interval
    if (progress.ivl > 0) {
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + progress.due);
      card.due = dueDate;
      card.scheduled_days = progress.ivl;
    }
  }

  return card;
}
