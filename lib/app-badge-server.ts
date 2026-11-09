/**
 * The app badge's counts on the server (docs/app-badge.md): one small query,
 * only the parts the mode needs, cached per isolate for a few seconds.
 *
 * - asks: lines of this account's chat (`chat_line`) that are ask cards with
 *   no answer, from the last ASK_WINDOW_MS;
 * - due: page cards (`fsrs_notes`, not deleted) and /words words
 *   (`word_cards`) due by now.
 *
 * Numbers only: no text, no ids, no names leave here.
 */
import type { D1Like } from "@/lib/d1/types";
import { ASK_WINDOW_MS, BADGE_MAX, type BadgeCounts, type BadgeMode } from "@/lib/app-badge";

/** How long an isolate reuses an account's counts. */
export const BADGE_CACHE_MS = 15_000;
/** Accounts an isolate keeps counts for; the oldest goes first. */
export const BADGE_CACHE_MAX = 500;

type Entry = { at: number; counts: BadgeCounts };
const cache = new Map<string, Entry>();

/** Tests: forget every cached count. */
export const clearBadgeCache = () => cache.clear();

export type BadgeAccount = { id: string; email: string };

const clamp = (n: unknown) => Math.min(Math.max(0, Math.floor(Number(n) || 0)), BADGE_MAX);

/** The counts for `mode`, straight from D1 (parts the mode leaves out are 0). */
export async function queryBadgeCounts(
  db: D1Like,
  who: BadgeAccount,
  mode: BadgeMode,
  now: number,
): Promise<BadgeCounts> {
  if (mode === "off") return { asks: 0, due: 0 };
  const wantAsks = mode !== "due-cards";
  const wantDue = mode !== "ask-cards";
  const iso = new Date(now).toISOString();
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (wantAsks) {
    parts.push(
      "(SELECT COUNT(*) FROM chat_line WHERE user_id = ? AND ask = 1 AND answer IS NULL AND at_ms >= ?) AS asks",
    );
    binds.push(who.id, now - ASK_WINDOW_MS);
  }
  if (wantDue) {
    parts.push(
      "(SELECT COUNT(*) FROM fsrs_notes WHERE email = ? AND card_due <= ? AND deleted_at IS NULL) AS notes",
      "(SELECT COUNT(*) FROM word_cards WHERE email = ? AND card_due <= ?) AS words",
    );
    binds.push(who.email, iso, who.email, iso);
  }
  const row = await db
    .prepare(`SELECT ${parts.join(", ")}`)
    .bind(...binds)
    .first<{ asks?: number; notes?: number; words?: number }>();
  return {
    asks: wantAsks ? clamp(row?.asks) : 0,
    due: wantDue ? clamp((Number(row?.notes) || 0) + (Number(row?.words) || 0)) : 0,
  };
}

/** queryBadgeCounts, reused for BADGE_CACHE_MS per account and mode in this isolate. */
export async function badgeCounts(
  db: D1Like,
  who: BadgeAccount,
  mode: BadgeMode,
  now = Date.now(),
): Promise<BadgeCounts> {
  const key = `${who.id}\n${mode}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < BADGE_CACHE_MS && now >= hit.at) return hit.counts;
  const counts = await queryBadgeCounts(db, who, mode, now);
  cache.delete(key);
  cache.set(key, { at: now, counts });
  while (cache.size > BADGE_CACHE_MAX) cache.delete(cache.keys().next().value!);
  return counts;
}
