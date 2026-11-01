/**
 * The live-view pointer, kept server-side (docs/live-view.md): one D1 row
 * (`live_view`, id 1), written only with a token the dev key signed, never
 * with an older serial. The route (app/api/live-view/route.ts) and the app
 * layout call these; tests pass a test D1 and their own keys.
 */
import { type LiveViewClaim, verifyLiveView } from "./rules";

/** The part of D1 used here. */
export interface LiveViewDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

type Row = { pointer: string | null; serial: number };

export async function readRow(db: LiveViewDb): Promise<Row | null> {
  return db.prepare("SELECT pointer, serial FROM live_view WHERE id = ?").bind(1).first<Row>();
}

/**
 * Store `pointer` (or clear it, null) at `serial` — only if `serial` is above
 * every serial accepted so far. False: a replay (or a stale one), nothing written.
 */
export async function writeSigned(
  db: LiveViewDb,
  pointer: string | null,
  serial: number,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO live_view (id, pointer, serial, updated_ms) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pointer = excluded.pointer, serial = excluded.serial,
         updated_ms = excluded.updated_ms
       WHERE excluded.serial > live_view.serial
       RETURNING serial`,
    )
    .bind(pointer, serial, now)
    .first<{ serial: number }>();
  return row?.serial === serial;
}

/** The owner's "stop" from a signed-in page: clears the pointer, keeps the serial. */
export async function clearPointer(db: LiveViewDb, now: number): Promise<void> {
  await db
    .prepare("UPDATE live_view SET pointer = NULL, updated_ms = ? WHERE id = 1")
    .bind(now)
    .run();
}

/** The stored pointer, if it still verifies and has not expired. */
export async function currentPointer(
  db: LiveViewDb,
  keys: CryptoKey[],
  now = Date.now(),
  allowLocal = false,
): Promise<{ token: string; claim: LiveViewClaim } | null> {
  const row = await readRow(db);
  if (!row?.pointer) return null;
  const v = await verifyLiveView(row.pointer, keys, { op: "on", now, allowLocal });
  return v.ok ? { token: row.pointer, claim: v.claim } : null;
}

/** What the page and the script may see of a claim. */
export const publicClaim = (c: LiveViewClaim) => ({
  serial: c.serial,
  exp: c.exp,
  branch: c.branch,
  sha: c.sha,
  widget: c.widget,
  islands: c.islands,
});

export type ApiAnswer = { status: number; body: Record<string, unknown> };

/**
 * POST /api/live-view: `{token}`, signed by the dev key. "on" stores the
 * pointer, "off" clears it, "status" reads it; on and off must carry a serial
 * above every one seen. No session is involved: the signature is the
 * authority, and it can only switch the owner's view between his own dev JS
 * and the built-in JS.
 */
export async function handlePost(
  body: unknown,
  db: LiveViewDb,
  keys: CryptoKey[],
  now = Date.now(),
  allowLocal = false,
): Promise<ApiAnswer> {
  const token = (body as { token?: unknown } | null)?.token;
  const v = await verifyLiveView(token, keys, { now, allowLocal });
  if (!v.ok) {
    const status = v.error === "malformed" || v.error === "no source" ? 400 : 401;
    return { status, body: { error: v.error } };
  }
  const c = v.claim;
  if (c.op === "status") {
    const cur = await currentPointer(db, keys, now, allowLocal);
    return { status: 200, body: cur ? { on: true, claim: publicClaim(cur.claim) } : { on: false } };
  }
  const ok = await writeSigned(db, c.op === "on" ? (token as string) : null, c.serial, now);
  if (!ok) return { status: 409, body: { error: "replayed" } };
  return {
    status: 200,
    body: c.op === "on" ? { on: true, claim: publicClaim(c) } : { on: false },
  };
}
