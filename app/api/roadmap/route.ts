import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import type { RoadmapGoal } from "@/types/roadmap";

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

  const collection = getRoadmapGoalsCollection(email);
  const goals = await collection.find({}).sort({ updatedAt: -1 }).toArray();
  return NextResponse.json(goals);
}

export async function POST(request: NextRequest) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  const parsed = SaveRoadmapSchema.safeParse(await request.json());
  if (!parsed.success) {
    return new NextResponse(parsed.error.message, { status: 400 });
  }
  const { topic, nodes } = parsed.data;

  const collection = getRoadmapGoalsCollection(email);
  const now = new Date();
  const goal: RoadmapGoal = { topic, nodes, createdAt: now, updatedAt: now };

  const result = await collection.insertOne(goal);
  return NextResponse.json({ _id: result.insertedId, ...goal });
}

export async function DELETE(request: NextRequest) {
  const email = await authEmailOrToken(request);
  if (!email) return new NextResponse("Unauthorized", { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return new NextResponse("Missing id", { status: 400 });
  if (!ObjectId.isValid(id)) return new NextResponse("Invalid id", { status: 400 });

  const collection = getRoadmapGoalsCollection(email);
  await collection.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
