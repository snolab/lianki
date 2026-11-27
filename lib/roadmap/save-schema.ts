/**
 * What POST /api/roadmap and PATCH /api/roadmap/<id> accept
 * (app/api/roadmap/route.ts, app/api/roadmap/[id]/route.ts). Kept here so the
 * generator's output (lib/roadmap/generate-schema.ts `fitRoadmap`) is tested
 * against the very contract it is saved with.
 *
 * The length cap of a doc's Markdown is config `roadmap.docMaxChars`, checked
 * by the routes (`docsFit`); `DOC_HARD_MAX` only bounds the parse.
 */
import { z } from "zod";

export const DOC_HARD_MAX = 200_000;
export const DONE_LOG_MAX = 1000;

const httpUrl = z
  .string()
  .max(2000)
  .refine((u) => {
    try {
      const p = new URL(u).protocol;
      return p === "https:" || p === "http:";
    } catch {
      return false;
    }
  }, "http(s) only");

export const RoadmapDocSchema = z.object({
  markdown: z.string().max(DOC_HARD_MAX).optional(),
  readerId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
  url: httpUrl.optional(),
  doneLog: z.array(z.string().max(40)).max(DONE_LOG_MAX).optional(),
});

export const RoadmapNodeSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().max(100),
  description: z.string().max(200),
  keywords: z.array(z.string().max(50)).max(8),
  order: z.number().int().min(0),
  stage: z.number().int().min(1).max(999).optional(),
  lane: z
    .string()
    .regex(/^[A-Z]$/)
    .optional(),
  kind: z.enum(["keywords", "deck", "doc"]).optional(),
  deck: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/) }).optional(),
  doc: RoadmapDocSchema.optional(),
});

export const SaveRoadmapSchema = z.object({
  topic: z.string().min(1).max(500),
  nodes: z.array(RoadmapNodeSchema).min(1).max(20),
});

/** YYYY-MM-DD that is a real calendar day. */
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, "not a day");

/** PATCH /api/roadmap/<id>: any of the goal (topic), its target date (null clears), its steps. */
export const PatchRoadmapSchema = z
  .object({
    topic: z.string().trim().min(1).max(500).optional(),
    targetDate: isoDay.nullable().optional(),
    nodes: z.array(RoadmapNodeSchema).min(1).max(20).optional(),
  })
  .refine((p) => p.topic !== undefined || p.targetDate !== undefined || p.nodes !== undefined, {
    message: "empty patch",
  });

/** Every doc's Markdown within `max` characters (config roadmap.docMaxChars). */
export function docsFit(nodes: { doc?: { markdown?: string } }[], max: number): boolean {
  return nodes.every((n) => (n.doc?.markdown?.length ?? 0) <= max);
}
