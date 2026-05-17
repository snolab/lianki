import { NextRequest } from "next/server";
import { parse } from "yaml";
import { z } from "zod";
import { authUserOrNull } from "@/app/signInEmail";
import { db } from "@/app/db";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { restoreNoteFromExport, restoreGoalFromExport, EXPORT_VERSION } from "@/lib/yaml-export";
import { dbBackend, getD1 } from "@/lib/d1";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { RoadmapGoalsD1Repo, PreferencesD1Repo } from "@/lib/repos/d1Repos";
import type { FSRSNote } from "@/app/fsrs";
import type { RoadmapGoal } from "@/types/roadmap";
import type { FilterPattern } from "@/app/api/preferences/route";

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

  let notesUpserted = 0;
  let goalsUpserted = 0;

  if (dbBackend() === "d1") {
    const d1 = getD1();
    const notesRepo = new FsrsNotesD1Repo(d1, email);
    for (const raw of data.fsrsNotes) {
      if (typeof raw.url !== "string" || !raw.url) continue;
      const note = restoreNoteFromExport(raw) as unknown as FSRSNote;
      const id = typeof raw.id === "string" ? raw.id : undefined;
      await notesRepo.upsert(note, id);
      notesUpserted++;
    }
    const goalsRepo = new RoadmapGoalsD1Repo(d1, email);
    for (const raw of data.roadmapGoals) {
      if (typeof raw.topic !== "string" || !raw.topic) continue;
      const goal = restoreGoalFromExport(raw) as unknown as RoadmapGoal & { id?: string };
      await goalsRepo.upsertByTopic(goal);
      goalsUpserted++;
    }
    if (data.preferences) {
      await new PreferencesD1Repo(d1, userId).set(
        (data.preferences.mobileExcludePatterns ?? []) as FilterPattern[],
      );
    }
  } else {
    const FSRSNotes = getFSRSNotesCollection(email);
    const RoadmapGoals = getRoadmapGoalsCollection(email);
    const Preferences = db.collection("preferences");

    for (const raw of data.fsrsNotes) {
      if (typeof raw.url !== "string" || !raw.url) continue;
      const note = restoreNoteFromExport(raw);
      await FSRSNotes.replaceOne({ url: raw.url }, note as any, { upsert: true });
      notesUpserted++;
    }
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
  }

  return Response.json({
    ok: true,
    notesUpserted,
    goalsUpserted,
    preferencesRestored: !!data.preferences,
  });
}
