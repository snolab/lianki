import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { State } from "ts-fsrs";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { D1FsrsCollection } from "@/app/fsrsNotesD1Collection";
import { dbBackend, getD1 } from "@/lib/d1";
import { RoadmapGoalsD1Repo } from "@/lib/repos/d1Repos";
import type { RoadmapNode, RoadmapNodeProgress } from "@/types/roadmap";
import type { ObjectId as ObjectIdType } from "mongodb";

const MATURE_STABILITY_DAYS = 21;

// MongoDB goals carry an ObjectId `_id`; D1 goals a string `id` we surface as
// `_id` for response parity. Only `nodes` feeds the maturity computation.
type GoalLike = { _id?: ObjectIdType | string; nodes: RoadmapNode[] };

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;

  // Fetch the goal and every note for this user from the active backend. D1 ids
  // are UUIDs (not ObjectIds), so the ObjectId guard only applies to MongoDB.
  let goal: GoalLike | null;
  let allNotes: { url?: string; title?: string; card: { state: State; stability: number } }[];

  if (dbBackend() === "d1") {
    const d1 = getD1();
    const d1Goal = await new RoadmapGoalsD1Repo(d1, email).getById(id);
    // expose `_id` so the client treats D1 and MongoDB responses the same
    goal = d1Goal ? { ...d1Goal, _id: d1Goal.id } : null;
    if (!goal) return new NextResponse("Not found", { status: 404 });
    allNotes = await new D1FsrsCollection(d1, email).find({}).toArray();
  } else {
    if (!ObjectId.isValid(id)) return new NextResponse("Invalid id", { status: 400 });
    goal = await getRoadmapGoalsCollection(email).findOne({ _id: new ObjectId(id) });
    if (!goal) return new NextResponse("Not found", { status: 404 });
    allNotes = await getFSRSNotesCollection(email)
      .find({}, { projection: { url: 1, title: 1, "card.state": 1, "card.stability": 1 } })
      .toArray();
  }

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
