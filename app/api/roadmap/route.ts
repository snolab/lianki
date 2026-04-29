import { NextRequest, NextResponse } from "next/server";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import type { RoadmapGoal } from "@/types/roadmap";
import { ObjectId } from "mongodb";

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

  const body = await request.json();
  const { topic, nodes } = body;

  if (!topic || !nodes || !Array.isArray(nodes)) {
    return new NextResponse("Invalid body", { status: 400 });
  }

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

  const collection = getRoadmapGoalsCollection(email);
  await collection.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
