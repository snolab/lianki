/**
 * Roadmap progress from the learner's cards: a card counts toward a step when
 * one of the step's keywords appears in its url or title (case-insensitive),
 * and it is mature once in Review with stability ≥ 21 days. Pure, so the
 * route (D1 or MongoDB) and the tests share it.
 */
import type { RoadmapNode, RoadmapNodeProgress } from "@/types/roadmap";
import type { CardStat } from "@/lib/repos/fsrsNotesD1";

export const MATURE_STABILITY_DAYS = 21;
/** ts-fsrs `State.Review`. */
const REVIEW = 2;

export function roadmapProgress(
  nodes: RoadmapNode[],
  cards: CardStat[],
): { nodes: RoadmapNodeProgress[]; overallMaturityRate: number } {
  const keywords = nodes.map((n) => n.keywords.map((k) => k.toLowerCase()).filter(Boolean));
  const counts = nodes.map(() => ({ totalCards: 0, matureCards: 0 }));

  for (const card of cards) {
    // Cardless notes (speed markers only) are not study cards.
    if (card.state == null) continue;
    const text = `${card.url ?? ""} ${card.title ?? ""}`.toLowerCase();
    const mature = card.state === REVIEW && (card.stability ?? 0) >= MATURE_STABILITY_DAYS;
    for (let i = 0; i < nodes.length; i++) {
      if (keywords[i].some((kw) => text.includes(kw))) {
        counts[i].totalCards += 1;
        if (mature) counts[i].matureCards += 1;
      }
    }
  }

  const progress = nodes.map((node, i) => {
    const { totalCards, matureCards } = counts[i];
    return {
      ...node,
      totalCards,
      matureCards,
      maturityRate: totalCards === 0 ? 0 : matureCards / totalCards,
    };
  });
  const total = progress.reduce((s, n) => s + n.totalCards, 0);
  const mature = progress.reduce((s, n) => s + n.matureCards, 0);
  return { nodes: progress, overallMaturityRate: total === 0 ? 0 : mature / total };
}
