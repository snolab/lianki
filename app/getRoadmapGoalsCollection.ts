import { db } from "./db";
import type { RoadmapGoal } from "@/types/roadmap";

export function getRoadmapGoalsCollection(email: string) {
  return db.collection<RoadmapGoal>(`RoadmapGoals@${email}`);
}
