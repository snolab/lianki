import { stringify } from "yaml";
import { authUserOrNull } from "@/app/signInEmail";
import { db } from "@/app/db";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";
import { serializeNoteForExport, serializeGoalForExport, EXPORT_VERSION } from "@/lib/yaml-export";

export async function GET() {
  const user = await authUserOrNull();
  if (!user?.email) {
    return Response.json({ error: "Login required" }, { status: 401 });
  }
  const { email, id: userId } = user;

  const [notes, goals, prefs] = await Promise.all([
    getFSRSNotesCollection(email).find({}).toArray(),
    getRoadmapGoalsCollection(email).find({}).toArray(),
    db.collection("preferences").findOne({ userId }),
  ]);

  const data = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    email,
    fsrsNotes: notes.map((n) => serializeNoteForExport(n as unknown as Record<string, unknown>)),
    roadmapGoals: goals.map((g) => serializeGoalForExport(g as unknown as Record<string, unknown>)),
    preferences: {
      mobileExcludePatterns: prefs?.mobileExcludePatterns ?? [],
    },
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
