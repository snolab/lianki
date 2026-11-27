/**
 * The shape the roadmap model is asked for, and how its answer is made fit
 * (`app/api/roadmap/generate`). The model often overshoots a limit: a
 * description of 230 characters, nine keywords, one step too many. Those used
 * to fail the whole call with a schema error (HTTP 500, 2026-11-27, "jlpt n1").
 * Now the schema the model sees is loose, and `fitRoadmap` trims and clamps
 * what came back; only an answer that cannot be repaired (fewer than
 * `MIN_STEPS` usable steps) is refused.
 */
import { z } from "zod";

export const MIN_STEPS = 3;
export const MAX_STEPS = 12;
export const DESCRIPTION_MAX = 200;
export const TITLE_MAX = 80;
export const MIN_KEYWORDS = 2;
export const MAX_KEYWORDS = 8;
/** The save route's per-keyword limit (app/api/roadmap/route.ts). */
export const KEYWORD_MAX = 50;

/** What the model must return: types only, no length limits (those are fixed after). */
export const LooseRoadmapSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      order: z.number().optional(),
    }),
  ),
});

export type LooseRoadmap = z.infer<typeof LooseRoadmapSchema>;

export type RoadmapStep = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  order: number;
};

/** Cut to `max` characters at a word boundary when one is near, with an ellipsis. */
export function trimText(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

/**
 * The model's answer made to fit: steps in their order, at most `MAX_STEPS`;
 * each with a unique id, a trimmed title and description, and 2–8 distinct
 * keywords (the title fills in when fewer came back). Null when fewer than
 * `MIN_STEPS` usable steps remain — the caller tries again or gives up.
 */
export function fitRoadmap(raw: LooseRoadmap): { nodes: RoadmapStep[] } | null {
  const usable = raw.nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => typeof n.title === "string" && n.title.trim().length > 0)
    .sort((a, b) => (a.n.order ?? a.i) - (b.n.order ?? b.i) || a.i - b.i)
    .slice(0, MAX_STEPS);
  if (usable.length < MIN_STEPS) return null;
  const seen = new Set<string>();
  const nodes = usable.map(({ n }, order) => {
    const title = trimText(n.title, TITLE_MAX);
    let id = slug(n.id ?? "") || slug(title) || `step_${order + 1}`;
    while (seen.has(id)) id = `${id}_${order + 1}`;
    seen.add(id);
    // Every keyword, the model's and the fallbacks alike, goes through `add`:
    // trimmed to KEYWORD_MAX and deduplicated (case-insensitive).
    const kw: string[] = [];
    const add = (k: unknown) => {
      if (kw.length >= MAX_KEYWORDS) return;
      const v = trimText(String(k ?? ""), KEYWORD_MAX);
      if (v && !kw.some((x) => x.toLowerCase() === v.toLowerCase())) kw.push(v);
    };
    for (const k of n.keywords ?? []) add(k);
    add(title);
    // Two keywords at least: the title's words fill in, then numbered stand-ins.
    for (const w of title.split(/\s+/)) if (kw.length < MIN_KEYWORDS) add(w);
    for (let i = 1; kw.length < MIN_KEYWORDS; i++) add(`step ${order + 1}.${i}`);
    return {
      id,
      title,
      description: trimText(n.description ?? "", DESCRIPTION_MAX),
      keywords: kw,
      order,
    };
  });
  return { nodes };
}
