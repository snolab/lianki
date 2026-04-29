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
  const goalsCollection = getRoadmapGoalsCollection(email);
  const goal = await goalsCollection.findOne({ _id: new ObjectId(id) });
  if (!goal) return new NextResponse("Not found", { status: 404 });

  const notesCollection = getFSRSNotesCollection(email);
  const allNotes = await notesCollection
    .find({}, { projection: { url: 1, title: 1, "card.state": 1, "card.stability": 1 } })
    .toArray();

  const nodeProgress: RoadmapNodeProgress[] = goal.nodes.map((node) => {
    const matchingNotes = allNotes.filter((note) => {
      const text = `${note.url} ${note.title ?? ""}`.toLowerCase();
      return node.keywords.some((kw) => text.includes(kw.toLowerCase()));
    });

    const matureNotes = matchingNotes.filter(
      (note) => note.card.state === State.Review && note.card.stability >= MATURE_STABILITY_DAYS,
    );

    const totalCards = matchingNotes.length;
    const matureCards = matureNotes.length;
    const maturityRate = totalCards === 0 ? 0 : matureCards / totalCards;

    return { ...node, totalCards, matureCards, maturityRate };
  });

  const totalCards = nodeProgress.reduce((sum, n) => sum + n.totalCards, 0);
  const matureCards = nodeProgress.reduce((sum, n) => sum + n.matureCards, 0);
  const overallMaturityRate = totalCards === 0 ? 0 : matureCards / totalCards;

  return NextResponse.json({ goal, nodes: nodeProgress, overallMaturityRate });
}
