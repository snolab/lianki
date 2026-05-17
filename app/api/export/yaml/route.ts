import { stringify } from "yaml";
import { authUserOrNull } from "@/app/signInEmail";
import { db } from "@/app/db";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { serializeNoteForExport, serializeGoalForExport, EXPORT_VERSION } from "@/lib/yaml-export";
import { dbBackend, getD1 } from "@/lib/d1";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { RoadmapGoalsD1Repo, PreferencesD1Repo } from "@/lib/repos/d1Repos";

export async function GET() {
  const user = await authUserOrNull();
  if (!user?.email) {
    return Response.json({ error: "Login required" }, { status: 401 });
  }
  const { email, id: userId } = user;

  let notes: Record<string, unknown>[];
  let goals: Record<string, unknown>[];
  let mobileExcludePatterns: unknown[];

  if (dbBackend() === "d1") {
    const d1 = getD1();
    const [d1Notes, d1Goals, prefs] = await Promise.all([
      new FsrsNotesD1Repo(d1, email).listAll(),
      new RoadmapGoalsD1Repo(d1, email).listAll(),
      new PreferencesD1Repo(d1, userId).get(),
    ]);
    notes = d1Notes as unknown as Record<string, unknown>[];
    goals = d1Goals as unknown as Record<string, unknown>[];
    mobileExcludePatterns = prefs?.mobileExcludePatterns ?? [];
  } else {
    const [mNotes, mGoals, prefs] = await Promise.all([
      getFSRSNotesCollection(email).find({}).toArray(),
      getRoadmapGoalsCollection(email).find({}).toArray(),
      db.collection("preferences").findOne({ userId }),
    ]);
    notes = mNotes as unknown as Record<string, unknown>[];
    goals = mGoals as unknown as Record<string, unknown>[];
    mobileExcludePatterns = prefs?.mobileExcludePatterns ?? [];
  }

  const data = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    email,
    fsrsNotes: notes.map((n) => serializeNoteForExport(n)),
    roadmapGoals: goals.map((g) => serializeGoalForExport(g)),
    preferences: { mobileExcludePatterns },
  };

  const yaml = stringify(data);
  const date = new Date().toISOString().slice(0, 10);

  return new Response(yaml, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Content-Disposition": `attachment; filename="lianki-export-${date}.yaml"`,
    },
  });
}
