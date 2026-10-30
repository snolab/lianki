/**
 * Ambient context on every chat line (owner, 2026-10-31): like the page's
 * address, automatic and continuous, never picked by hand. `page` is where
 * the line was sent from (path and a cleaned query); `focus` is the state
 * tree's current node, if he has one (the focus line, StateTree): SOFT
 * context — it may or may not be what he is talking about. The hub never
 * routes by it (only an explicit `to` routes); the agent judges relevance.
 *
 * Only node titles and statuses travel, never anyone's other content, and
 * everything is capped. Pure, no imports: the push Worker bundles it.
 */

export type AmbientFocus = {
  /** The node's titles from the top, "Plan › Lane A › Mic" (capped). */
  nodePath: string;
  title: string;
  status?: "open" | "doing" | "blocked" | "done";
  /** Its subtree as titles and statuses, depth first (capped). */
  summary?: string;
};
export type Ambient = {
  page: { path: string; query?: string };
  focus?: AmbientFocus;
};

export const MAX_AMBIENT_PATH = 200;
export const MAX_AMBIENT_QUERY = 200;
export const MAX_FOCUS_PATH = 200;
export const MAX_FOCUS_TITLE = 120;
export const MAX_FOCUS_SUMMARY = 400;
const STATUSES = new Set(["open", "doing", "blocked", "done"]);

/** A query parameter that may carry a secret: its name, or a long opaque value. */
const SECRET_KEY = /token|secret|key|code|auth|pass|sig|session|grant|otp|jwt|cred/i;
const OPAQUE = /^[A-Za-z0-9_\-+/=.]{24,}$/;

/** The query without anything secret-looking, "a=1&b=2" (no "?"), or undefined. */
export function cleanQuery(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const q = raw.replace(/^\?/, "");
  if (!q) return undefined;
  const kept: string[] = [];
  for (const part of q.split("&")) {
    if (!part) continue;
    const [k = "", v = ""] = part.split("=");
    let dk = k;
    let dv = v;
    try {
      dk = decodeURIComponent(k);
      dv = decodeURIComponent(v);
    } catch {}
    if (SECRET_KEY.test(dk) || OPAQUE.test(dv)) continue;
    kept.push(part);
  }
  const out = kept.join("&").slice(0, MAX_AMBIENT_QUERY);
  return out || undefined;
}

const text = (raw: unknown, max: number) =>
  typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** An Ambient from the wire, cleaned and capped; undefined without a page path. */
export function cleanAmbient(raw: unknown): Ambient | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { page?: { path?: unknown; query?: unknown }; focus?: Record<string, unknown> };
  const path = text(r.page?.path, MAX_AMBIENT_PATH);
  if (!path.startsWith("/")) return undefined;
  const query = cleanQuery(r.page?.query);
  const out: Ambient = { page: { path, ...(query ? { query } : {}) } };
  const f = r.focus;
  if (f && typeof f === "object") {
    const title = text(f.title, MAX_FOCUS_TITLE);
    const nodePath = text(f.nodePath, MAX_FOCUS_PATH);
    if (title && nodePath) {
      const summary = text(f.summary, MAX_FOCUS_SUMMARY);
      out.focus = {
        nodePath,
        title,
        ...(typeof f.status === "string" && STATUSES.has(f.status)
          ? { status: f.status as AmbientFocus["status"] }
          : {}),
        ...(summary ? { summary } : {}),
      };
    }
  }
  return out;
}

type Node = { title: string; status?: string; children?: readonly Node[] };

/**
 * A node's subtree as "title [status]; child [status]; …", depth first,
 * cut at MAX_FOCUS_SUMMARY (titles and statuses only).
 */
export function subtreeSummary(n: Node, max = MAX_FOCUS_SUMMARY): string {
  const parts: string[] = [];
  let len = 0;
  const walk = (x: Node, depth: number) => {
    for (const c of x.children ?? []) {
      if (len > max) return;
      const p = `${"·".repeat(depth)}${c.title}${c.status ? ` [${c.status}]` : ""}`;
      parts.push(p);
      len += p.length + 2;
      walk(c, depth + 1);
    }
  };
  walk(n, 0);
  return parts.join("; ").slice(0, max);
}
