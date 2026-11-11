/**
 * What the SttRegistry (workers/push/src/stt-registry.ts) asks the main Worker
 * over DebugSessions (worker.ts): is this speech server's key a live
 * stt_worker row, and book one utterance it served to an account
 * (docs/local-stt.md, "Lianki's speech servers for everyone"). Both answer
 * nothing while the flag stt.worker is off.
 */
import { configLive, flagLive, type SessionDb } from "@/lib/debug-session";
import { LOCAL_STT_FEATURE, bookCost } from "@/lib/payments/cost-ledger";
import { sttWorkerByKey, type SttDb } from "./store";

/** The longest utterance booked from one report (config stt.worker.maxUtteranceS is at most 120 s). */
export const STT_BOOK_MAX_MS = 120_000;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type SttWorkerAnswer = { id: string; ownerUserId: string | null; capacity: number | null };

/** The live worker with this key while the flag is on, else null. */
export async function sttWorkerLive(db: unknown, pubkey: unknown): Promise<SttWorkerAnswer | null> {
  if (typeof pubkey !== "string") return null;
  if (!(await flagLive(db as SessionDb, "stt.worker"))) return null;
  const w = await sttWorkerByKey(db as SttDb, pubkey);
  return w ? { id: w.id, ownerUserId: w.ownerUserId, capacity: w.capacity } : null;
}

/**
 * Book `audioMs` served to `userId` as `speech.stt.local` at the config rate
 * (stt.local.costPerMinUsd). Charges nothing. False when it booked nothing.
 */
export async function bookSttUsage(
  db: unknown,
  userId: unknown,
  audioMs: unknown,
  now = new Date(),
): Promise<boolean> {
  const ms = Number(audioMs);
  if (typeof userId !== "string" || !USER_ID.test(userId)) return false;
  if (!Number.isFinite(ms) || ms <= 0) return false;
  if (!(await flagLive(db as SessionDb, "stt.worker"))) return false;
  const clamped = Math.min(STT_BOOK_MAX_MS, ms);
  let rate = 0;
  try {
    const r = await configLive(db as SessionDb, "stt.local.costPerMinUsd");
    if (typeof r === "number" && Number.isFinite(r)) rate = Math.max(0, r);
  } catch {}
  return bookCost(
    db as Parameters<typeof bookCost>[0],
    { userId, feature: LOCAL_STT_FEATURE, usd: (clamped / 60_000) * rate, units: clamped / 1000 },
    now,
  );
}
