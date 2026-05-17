import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import type { RoadmapGoal } from "@/types/roadmap";
import { dbBackend, getD1 } from "@/lib/d1";
import { RoadmapGoalsD1Repo } from "@/lib/repos/d1Repos";

const RoadmapNodeSchema = z.object({
  id: z.string(),
  title: z.string().max(100),
  description: z.string().max(200),
  keywords: z.array(z.string().max(50)).min(1).max(8),
  order: z.number().int().min(0),
});

const SaveRoadmapSchema = z.object({
  topic: z.string().min(1).max(500),
  nodes: z.array(RoadmapNodeSchema).min(1).max(20),
});

export async function GET(request: NextRequest) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  if (dbBackend() === "d1") {
    const goals = await new RoadmapGoalsD1Repo(getD1(), email).listAll();
    // expose `_id` so the client treats D1 and MongoDB responses the same
    return NextResponse.json(goals.map((g) => ({ ...g, _id: g.id })));
  }

  const collection = getRoadmapGoalsCollection(email);
  const goals = await collection.find({}).sort({ updatedAt: -1 }).toArray();
  return NextResponse.json(goals);
}

export async function POST(request: NextRequest) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }
  const parsed = SaveRoadmapSchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse(parsed.error.message, { status: 400 });
  }
  const { topic, nodes } = parsed.data;
  const now = new Date();
  const goal: RoadmapGoal = { topic, nodes, createdAt: now, updatedAt: now };

  if (dbBackend() === "d1") {
    const id = await new RoadmapGoalsD1Repo(getD1(), email).upsertByTopic(goal);
    return NextResponse.json({ _id: id, id, ...goal });
  }

  const result = await getRoadmapGoalsCollection(email).insertOne(goal);
  return NextResponse.json({ _id: result.insertedId, ...goal });
}

export async function DELETE(request: NextRequest) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return new NextResponse("Missing id", { status: 400 });

  if (dbBackend() === "d1") {
    await new RoadmapGoalsD1Repo(getD1(), email).delete(id);
    return NextResponse.json({ ok: true });
  }

  if (!ObjectId.isValid(id)) return new NextResponse("Invalid id", { status: 400 });
  await getRoadmapGoalsCollection(email).deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
