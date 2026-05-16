import { NextRequest } from "next/server";
import { parse } from "yaml";
import { z } from "zod";
import { authUserOrNull } from "@/app/signInEmail";
import { db } from "@/app/db";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { restoreNoteFromExport, restoreGoalFromExport, EXPORT_VERSION } from "@/lib/yaml-export";

const zExport = z.object({
  version: z.string(),
  email: z.string(),
  fsrsNotes: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  roadmapGoals: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  preferences: z.object({ mobileExcludePatterns: z.array(z.unknown()).optional() }).optional(),
});

export async function POST(req: NextRequest) {
  const user = await authUserOrNull();
  if (!user?.email) {
    return Response.json({ error: "Login required" }, { status: 401 });
  }
  const { email, id: userId } = user;

  let text: string;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Missing file field" }, { status: 400 });
    }
    text = await file.text();
  } else {
    text = await req.text();
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return Response.json({ error: "Invalid YAML" }, { status: 400 });
  }

  const result = zExport.safeParse(parsed);
  if (!result.success) {
    return Response.json(
      { error: "Invalid export format", details: result.error.flatten() },
      { status: 400 },
    );
  }

  const data = result.data;
  if (data.version !== EXPORT_VERSION) {
    return Response.json({ error: `Unsupported version: ${data.version}` }, { status: 400 });
  }

  const FSRSNotes = getFSRSNotesCollection(email);
  const RoadmapGoals = getRoadmapGoalsCollection(email);
  const Preferences = db.collection("preferences");

  let notesUpserted = 0;
  for (const raw of data.fsrsNotes) {
    if (typeof raw.url !== "string" || !raw.url) continue;
    const note = restoreNoteFromExport(raw);
    await FSRSNotes.replaceOne({ url: raw.url }, note as any, { upsert: true });
    notesUpserted++;
  }

  let goalsUpserted = 0;
  for (const raw of data.roadmapGoals) {
    if (typeof raw.topic !== "string" || !raw.topic) continue;
    const goal = restoreGoalFromExport(raw);
    await RoadmapGoals.replaceOne({ topic: raw.topic }, goal as any, { upsert: true });
    goalsUpserted++;
  }

  if (data.preferences) {
    await Preferences.updateOne(
      { userId },
      {
        $set: {
          userId,
          mobileExcludePatterns: data.preferences.mobileExcludePatterns ?? [],
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  return Response.json({
    ok: true,
    notesUpserted,
    goalsUpserted,
    preferencesRestored: !!data.preferences,
  });
}
