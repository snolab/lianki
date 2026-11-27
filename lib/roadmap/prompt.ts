/**
 * The roadmap model's prompt (app/api/roadmap/generate). It asks for the
 * ordering notation (lib/roadmap/notation.ts): `step` "1", "2A", "2B", "3",
 * numbers in sequence and letters for steps of one stage that can be done in
 * parallel. When the wish names exam decks of the word-list catalogue
 * (lib/roadmap/exam-match.ts), they are offered as deck steps by id; any
 * other id the model writes is dropped by `fitRoadmap`.
 */
export function roadmapPrompt(
  topic: string,
  decks: readonly { id: string; name: string }[],
): string {
  const deckLines = decks.length
    ? `
Word-list decks the learner can study in the app for this goal (id: name):
${decks.map((d) => `- ${d.id}: ${d.name}`).join("\n")}
Make one step per deck that fits, with "deck" set to that id exactly. Use no other deck ids.`
    : "";
  return `Generate a learning roadmap for: "${topic}"

Create 5-10 learning milestones. Each node should represent a concrete skill or knowledge area.

Order the steps with the "step" label: a stage number, and a letter when several steps of the same stage can be studied in parallel. Numbers are sequential, letters are parallel within a stage. Example: "1", "2A", "2B", "2C", "3". Use a letter only when a stage has two or more steps.

For each node, provide:
- id: unique snake_case identifier
- step: the label as above
- title: short milestone title (max 50 chars)
- description: what the learner should know/do (max 200 chars)
- keywords: 2-8 keywords that would appear in study materials/URLs for this topic (e.g. "python loops", "for loop", "iteration")
- order: 0-based position in the list
- checklist (optional, for steps that are not a word deck): 3-8 short, concrete items the learner can tick off (max 100 chars each)
${deckLines}
Progress from fundamentals to advanced. Keywords should be specific enough to match real study cards.`;
}
