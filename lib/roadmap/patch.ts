/**
 * The checks of PATCH /api/roadmap/<id>, as a pure function so the tests
 * run them without a server: the body's shape (save-schema.ts), each doc's
 * Markdown within config `roadmap.docMaxChars`, and the steps put in
 * notation order. Markdown is text only: nothing here touches the file store
 * or its quota, so a full file space never stops a doc from saving.
 */
import type { RoadmapNode } from "@/types/roadmap";
import { normalizeSteps } from "./notation";
import { PatchRoadmapSchema, docsFit } from "./save-schema";

export type CheckedPatch =
  | { ok: true; patch: { topic?: string; targetDate?: string | null; nodes?: RoadmapNode[] } }
  | { ok: false; status: 400 | 413; error: "invalid-body" | "doc-too-long" };

export function checkRoadmapPatch(body: unknown, docMaxChars: number): CheckedPatch {
  const parsed = PatchRoadmapSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: "invalid-body" };
  const p = parsed.data;
  if (p.nodes && !docsFit(p.nodes, docMaxChars))
    return { ok: false, status: 413, error: "doc-too-long" };
  const patch: { topic?: string; targetDate?: string | null; nodes?: RoadmapNode[] } = {};
  if (p.topic !== undefined) patch.topic = p.topic;
  if (p.targetDate !== undefined) patch.targetDate = p.targetDate;
  if (p.nodes) patch.nodes = normalizeSteps(p.nodes);
  return { ok: true, patch };
}
