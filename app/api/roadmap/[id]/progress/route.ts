import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { State } from "ts-fsrs";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import type { RoadmapNodeProgress } from "@/types/roadmap";

const MATURE_STABILITY_DAYS = 21;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  if (!ObjectId.isValid(id)) return new NextResponse("Invalid id", { status: 400 });

  const goalsCollection = getRoadmapGoalsCollection(email);
  const goal = await goalsCollection.findOne({ _id: new ObjectId(id) });
  if (!goal) return new NextResponse("Not found", { status: 404 });

  const notesCollection = getFSRSNotesCollection(email);
  const allNotes = await notesCollection
    .find({}, { projection: { url: 1, title: 1, "card.state": 1, "card.stability": 1 } })
    .toArray();

  // Precompute lowercase keywords per node and lowercase text per note for O(notes + nodes*keywords)
  const normalizedNodes = goal.nodes.map((node) => ({
    ...node,
    normalizedKeywords: node.keywords.map((kw) => kw.toLowerCase()),
  }));
  const nodeCounts = normalizedNodes.map(() => ({ totalCards: 0, matureCards: 0 }));

  for (const note of allNotes) {
    const text = `${note.url} ${note.title ?? ""}`.toLowerCase();
    const isMature =
      note.card.state === State.Review && note.card.stability >= MATURE_STABILITY_DAYS;

    for (let i = 0; i < normalizedNodes.length; i++) {
      if (normalizedNodes[i].normalizedKeywords.some((kw) => text.includes(kw))) {
        nodeCounts[i].totalCards += 1;
        if (isMature) nodeCounts[i].matureCards += 1;
      }
    }
  }

  const nodeProgress: RoadmapNodeProgress[] = goal.nodes.map((node, i) => {
    const { totalCards, matureCards } = nodeCounts[i];
    const maturityRate = totalCards === 0 ? 0 : matureCards / totalCards;
    return { ...node, totalCards, matureCards, maturityRate };
  });

  const totalCards = nodeProgress.reduce((sum, n) => sum + n.totalCards, 0);
  const matureCards = nodeProgress.reduce((sum, n) => sum + n.matureCards, 0);
  const overallMaturityRate = totalCards === 0 ? 0 : matureCards / totalCards;

  return NextResponse.json({ goal, nodes: nodeProgress, overallMaturityRate });
}
