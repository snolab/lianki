import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import { RoadmapGoalsD1Repo } from "@/lib/repos/d1Repos";
import { cfg } from "@/lib/config-store";
import { checkRoadmapPatch } from "@/lib/roadmap/patch";

/**
 * PATCH /api/roadmap/<id> — change one of the user's own roadmaps: the goal
 * (`topic`), its `targetDate` (YYYY-MM-DD, null clears) and/or its `nodes`
 * (a doc's Markdown, a ticked checkbox, an added step). Steps are saved in
 * notation order (lib/roadmap/notation.ts). Images never pass here: they are
 * files (lib/roadmap/doc-image.ts) and the Markdown only holds their address.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await authEmailOrToken(request);
  if (!email) return NextResponse.json({ error: "login-required" }, { status: 401 });
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  const checked = checkRoadmapPatch(body, await cfg("roadmap.docMaxChars"));
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: checked.status });
  const patch = checked.patch;

  try {
    if (dbBackend() === "d1") {
      const repo = new RoadmapGoalsD1Repo(getD1(), email);
      if (!(await repo.getById(id)))
        return NextResponse.json({ error: "not-found" }, { status: 404 });
      await repo.update(id, patch);
      const goal = await repo.getById(id);
      return NextResponse.json({ ...goal, _id: id });
    }
    if (!ObjectId.isValid(id)) return NextResponse.json({ error: "invalid-id" }, { status: 400 });
    const col = getRoadmapGoalsCollection(email);
    const r = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!r) return NextResponse.json({ error: "not-found" }, { status: 404 });
    return NextResponse.json(r);
  } catch (e) {
    // The unique (email, topic) index: another roadmap already has this goal.
    if (/unique|duplicate|E11000/i.test(String((e as { message?: string })?.message ?? "")))
      return NextResponse.json({ error: "topic-taken" }, { status: 409 });
    throw e;
  }
}
