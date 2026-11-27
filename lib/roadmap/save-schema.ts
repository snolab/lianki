/**
 * What POST /api/roadmap accepts (app/api/roadmap/route.ts). Kept here so the
 * generator's output (lib/roadmap/generate-schema.ts `fitRoadmap`) is tested
 * against the very contract it is saved with.
 */
import { z } from "zod";

export const RoadmapNodeSchema = z.object({
  id: z.string(),
  title: z.string().max(100),
  description: z.string().max(200),
  keywords: z.array(z.string().max(50)).min(1).max(8),
  order: z.number().int().min(0),
});

export const SaveRoadmapSchema = z.object({
  topic: z.string().min(1).max(500),
  nodes: z.array(RoadmapNodeSchema).min(1).max(20),
});
