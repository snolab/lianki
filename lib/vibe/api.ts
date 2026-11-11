// What /api/vibe/* answers, without the Next plumbing (lib/vibe/route.ts is
// that), so the gate and the refusals are unit-tested as they run.
import type { FlagValues } from "@/lib/flags";
import type { D1Batch } from "@/lib/read/reader-store";
import { langTag } from "@/lib/read/translate";
import type { Complete } from "@/lib/read/gloss-server";
import { cleanTitle } from "@/lib/read/title";
import { checkRetention, vibeAllowed } from "./gate";
import { translateLine } from "./translate-server";
import { TOP_UP_PATH } from "@/lib/payments/metered";
import {
  appendLines,
  clearRetentionDays,
  getRetentionDays,
  setDocState,
  setRetentionDays,
  startDoc,
  type VibeState,
} from "./store";

export type VibeWho = { userId: string; owner: boolean } | null;
export type Reply = { status: number; body: Record<string, unknown> };

const nope = (status: number, error: string): Reply => ({ status, body: { error } });
export const NOT_FOUND: Reply = nope(404, "Not found");

/**
 * The whole gate: signed in, the D1 backend, the flag on, and the owner. The
 * flag has no owner bypass. Anything else answers as if the feature did not
 * exist, before any body is read or any row is touched.
 */
export function vibeUserId(
  who: VibeWho,
  flags: FlagValues | null | undefined,
  backend: string,
): string | null {
  if (!who || backend !== "d1") return null;
  return vibeAllowed(flags, who.owner) ? who.userId : null;
}

const asObject = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * POST /api/vibe, the start page's button. `tap` must be exactly true: there is
 * no other way to open a conversation.
 */
export async function startReply(
  db: D1Batch,
  userId: string,
  raw: unknown,
  now: number,
): Promise<Reply> {
  const b = asObject(raw);
  if (b.tap !== true) return nope(400, "tap-required");
  const title = cleanTitle(b.title);
  if (!title) return nope(400, "bad-title");
  return { status: 200, body: { id: await startDoc(db, userId, { title, now }) } };
}

export const MAX_BATCH_LINES = 100;

export type AppendedTo = { material: string; hash: string };

/** POST /api/vibe/[id]/lines: `{from, lines}`. 409 when it is paused or stopped. */
export async function linesReply(
  db: D1Batch,
  userId: string,
  id: string,
  raw: unknown,
  now: number,
): Promise<Reply & { appended?: AppendedTo }> {
  const b = asObject(raw);
  if (!Number.isInteger(b.from) || (b.from as number) < 0) return nope(400, "bad-body");
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > MAX_BATCH_LINES)
    return nope(400, "bad-body");
  const r = await appendLines(db, userId, id, b.from as number, b.lines, now);
  if (!r.ok) {
    const status = {
      "not-found": 404,
      "not-running": 409,
      "out-of-order": 409,
      "too-much-text": 413,
    };
    return nope(status[r.error], r.error);
  }
  return {
    status: 200,
    body: { next: r.next, material: r.materialId, langs: r.langs },
    ...(r.hash && r.materialId ? { appended: { material: r.materialId, hash: r.hash } } : {}),
  };
}

const STATES = new Set<VibeState>(["running", "paused", "stopped"]);

/** POST /api/vibe/[id]/state: `{state}`. Stopped is final: 409 on anything after it. */
export async function stateReply(
  db: D1Batch,
  userId: string,
  id: string,
  raw: unknown,
): Promise<Reply> {
  const state = asObject(raw).state as VibeState;
  if (!STATES.has(state)) return nope(400, "bad-body");
  const r = await setDocState(db, userId, id, state);
  if (r === "not-found") return NOT_FOUND;
  if (r === "stopped") return nope(409, "stopped");
  return { status: 200, body: { state } };
}

/** POST /api/vibe/[id]/translate: one finished line, into one language. */
export async function translateLineReply(
  db: D1Batch,
  who: string | { userId: string; email?: string | null },
  id: string,
  raw: unknown,
  now: number,
  complete?: Complete,
): Promise<Reply> {
  const b = asObject(raw);
  const to = langTag(b.to);
  if (!to || typeof b.text !== "string") return nope(400, "bad-body");
  const r = await translateLine(
    db,
    who,
    id,
    { text: b.text, to, from: langTag(b.from) },
    now,
    complete,
  );
  if (r.ok) return { status: 200, body: { text: r.text, cached: r.cached } };
  if (r.error === "no-credits")
    return {
      status: 402,
      body: { error: "no-credits", balance: r.balance, need: r.need, topUp: TOP_UP_PATH },
    };
  if (r.error === "credits-paused") return { status: 503, body: { error: "credits-paused" } };
  const status = {
    "not-found": 404,
    paused: 409,
    "not-a-line": 400,
    empty: 400,
    busy: 429,
    "model-failed": 502,
    "not-configured": 503,
  };
  return nope(status[r.error], r.error);
}

export async function settingsGetReply(db: D1Batch, userId: string): Promise<Reply> {
  return { status: 200, body: { days: await getRetentionDays(db, userId) } };
}

export async function settingsPutReply(
  db: D1Batch,
  userId: string,
  raw: unknown,
  now: number,
): Promise<Reply> {
  const asked = asObject(raw).days;
  if (asked === null) {
    await clearRetentionDays(db, userId, now);
    return { status: 200, body: { days: null } };
  }
  const days = checkRetention(asked);
  if (days === null) return nope(400, "bad-days");
  await setRetentionDays(db, userId, days, now);
  return { status: 200, body: { days } };
}
