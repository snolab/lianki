import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import { RoadmapGoalsD1Repo } from "@/lib/repos/d1Repos";
import { FsrsNotesD1Repo, type CardStat } from "@/lib/repos/fsrsNotesD1";
import { roadmapProgress } from "@/lib/roadmap/progress";
import type { RoadmapNode } from "@/types/roadmap";

// MongoDB goals carry an ObjectId `_id`; D1 goals a string `id` we surface as
// `_id` for response parity. Structural `_id` type (ObjectId and string both
// satisfy it). Only `nodes` feeds the maturity computation.
type GoalLike = { _id?: { toString(): string }; nodes: RoadmapNode[] };

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;

  // The goal and the url/title/state/stability of every card, from the active
  // backend. D1 ids are UUIDs (not ObjectIds), so the ObjectId guard only
  // applies to MongoDB. A note without a card (speed markers only) has no
  // state; roadmapProgress skips it. Reading `note.card.state` on one used to
  // throw, so a single such note made this route 500 and the detail pane
  // never appeared.
  let goal: GoalLike | null;
  let cards: CardStat[];

  if (dbBackend() === "d1") {
    const d1 = getD1();
    const d1Goal = await new RoadmapGoalsD1Repo(d1, email).getById(id);
    // expose `_id` so the client treats D1 and MongoDB responses the same
    goal = d1Goal ? { ...d1Goal, _id: d1Goal.id } : null;
    if (!goal) return new NextResponse("Not found", { status: 404 });
    cards = await new FsrsNotesD1Repo(d1, email).listCardStats();
  } else {
    if (!ObjectId.isValid(id)) return new NextResponse("Invalid id", { status: 400 });
    goal = await getRoadmapGoalsCollection(email).findOne({ _id: new ObjectId(id) });
    if (!goal) return new NextResponse("Not found", { status: 404 });
    const notes = await getFSRSNotesCollection(email)
      .find({}, { projection: { url: 1, title: 1, "card.state": 1, "card.stability": 1 } })
      .toArray();
    cards = notes.map((n) => ({
      url: n.url,
      title: n.title ?? undefined,
      state: n.card?.state,
      stability: n.card?.stability,
    }));
  }

  const { nodes, overallMaturityRate } = roadmapProgress(goal.nodes, cards);
  return NextResponse.json({ goal, nodes, overallMaturityRate });
}
