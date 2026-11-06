// /vibe's writes (docs/vibe.md). The transcript is an ordinary /read material
// owned by the user; every query here names the user, so another account gets
// exactly what it gets for a doc that does not exist.
import {
  getReadMaterialById,
  replaceReadMaterialText,
  saveReadMaterial,
} from "@/lib/getReadMaterialsCollection";
import { bookMetaOf, checkBook, type BookMeta, type ParsedBook } from "@/lib/read/book";
import { detectLangs, primaryLang, toRuns } from "@/lib/read/lang-detect";
import { checkShape, type TextShape } from "@/lib/read/prep";
import { carrySentenceCards, unchangedLines, type D1Batch } from "@/lib/read/reader-store";
import { bookHash } from "@/lib/read/units";
import { RETENTION_DEFAULT_DAYS } from "./gate";

export type VibeState = "running" | "paused" | "stopped";

type DocRow = {
  id: string;
  material_id: string | null;
  title: string;
  status: VibeState;
  next_seq: number;
};

/** A line as stored: one utterance, on one line, no control characters. */
export const MAX_LINE_CHARS = 4_000;
export function cleanLine(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim()
    .slice(0, MAX_LINE_CHARS);
}

/**
 * The start button's write. The caller has checked the gate and the consent.
 * One writer at a time: any other open conversation of this user closes.
 */
export async function startDoc(
  db: D1Batch,
  userId: string,
  o: { title: string; otherLang: string; now: number },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare("UPDATE vibe_doc SET status = 'stopped' WHERE user_id = ? AND status != 'stopped'")
      .bind(userId),
    db
      .prepare(
        `INSERT INTO vibe_doc (id, user_id, title, status, other_lang, consent_ms, started_ms, last_ms)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .bind(id, userId, o.title, o.otherLang, o.now, o.now, o.now),
  ]);
  return id;
}

const docOf = (db: D1Batch, userId: string, id: string) =>
  db
    .prepare(
      "SELECT id, material_id, title, status, next_seq FROM vibe_doc WHERE id = ? AND user_id = ?",
    )
    .bind(id, userId)
    .first<DocRow>();

/**
 * A speech transcript's shape: never "raw", so the detector's backfill on open
 * has nothing to add (nothing rewrites the row while lines are arriving) and
 * nothing offers a polish.
 */
const shapeOf = (langs: readonly string[]): TextShape =>
  checkShape({
    v: 1,
    raw: false,
    mixed: new Set(langs).size > 1,
    langs: [...new Set(langs)],
    signals: {},
  }) as TextShape;

export type AppendResult =
  | { ok: true; next: number; materialId: string | null; hash?: string; langs: string[] }
  | { ok: false; error: "not-found" | "not-running" | "out-of-order" | "too-much-text" };

/**
 * Lines `from`, `from + 1`, … of a running conversation, onto the end of its
 * material. A batch that overlaps what is held (a retry after a lost answer)
 * adds only what is new. Refused unless the doc is running: a late final after
 * a pause cannot reach the text, whatever the page does.
 */
export async function appendLines(
  db: D1Batch,
  userId: string,
  id: string,
  from: number,
  raw: readonly unknown[],
  now: number,
): Promise<AppendResult> {
  const doc = await docOf(db, userId, id);
  if (!doc) return { ok: false, error: "not-found" };
  if (doc.status !== "running") return { ok: false, error: "not-running" };
  if (from > doc.next_seq) return { ok: false, error: "out-of-order" };
  const unseen = raw.slice(doc.next_seq - from);
  const next = doc.next_seq + unseen.length;
  const fresh = unseen.map(cleanLine).filter(Boolean);
  if (!fresh.length)
    return { ok: true, next: doc.next_seq, materialId: doc.material_id, langs: [] };

  const prev = doc.material_id ? await getReadMaterialById(userId, doc.material_id) : null;
  if (doc.material_id && !prev) return { ok: false, error: "not-found" };
  const lines = [...(prev?.lines ?? []), ...fresh];

  // Each line in its own language, by the reader's own detection.
  const langs = detectLangs(lines);
  const input: ParsedBook = {
    title: doc.title,
    lang: primaryLang(lines),
    lines,
    chapters: [],
    headings: [],
  };
  const checked = checkBook(input);
  if (!checked.ok)
    return { ok: false, error: checked.error === "too-much-text" ? "too-much-text" : "not-found" };
  const runs = new Set(langs).size > 1 ? toRuns(langs) : undefined;
  const meta: BookMeta = bookMetaOf(
    { ...checked.book, ...(runs ? { langs: runs } : {}) },
    { source: "vibe", shape: shapeOf(langs) },
  );
  const content = JSON.stringify(meta);
  const hash = await bookHash(lines);

  let materialId = doc.material_id;
  if (prev && materialId) {
    // Only the end grew: every earlier line's sentence cards move to the new hash.
    const prevHash = prev.contentHash ?? (await bookHash(prev.lines));
    await carrySentenceCards(db, userId, prevHash, hash, unchangedLines(prev.lines, lines));
    await replaceReadMaterialText(userId, materialId, doc.title, lines, content, hash);
  } else {
    const made = await saveReadMaterial(userId, doc.title, content, lines, hash, `vibe:${id}`);
    materialId = String(made._id);
  }
  // Text first, then the count: a failure between them repeats a line rather than losing one.
  await db
    .prepare(
      "UPDATE vibe_doc SET material_id = ?, next_seq = ?, last_ms = ? WHERE id = ? AND user_id = ?",
    )
    .bind(materialId, next, now, id, userId)
    .run();
  return { ok: true, next, materialId, hash, langs: langs.slice(-fresh.length) };
}

/**
 * Pause, resume, stop. Stopped is final (the next conversation goes through
 * consent again). A stopped conversation that heard nothing leaves no row.
 */
export async function setDocState(
  db: D1Batch,
  userId: string,
  id: string,
  state: VibeState,
): Promise<"ok" | "not-found" | "stopped"> {
  const doc = await docOf(db, userId, id);
  if (!doc) return "not-found";
  if (doc.status === "stopped") return state === "stopped" ? "ok" : "stopped";
  if (state === "stopped" && !doc.material_id) {
    await db.prepare("DELETE FROM vibe_doc WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return "ok";
  }
  await db
    .prepare("UPDATE vibe_doc SET status = ? WHERE id = ? AND user_id = ?")
    .bind(state, id, userId)
    .run();
  return "ok";
}

export async function getRetentionDays(db: D1Batch, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT retention_days FROM vibe_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ retention_days: number }>();
  return row?.retention_days ?? RETENTION_DEFAULT_DAYS;
}

export async function setRetentionDays(
  db: D1Batch,
  userId: string,
  days: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vibe_settings (user_id, retention_days, updated_ms) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET retention_days = excluded.retention_days, updated_ms = excluded.updated_ms`,
    )
    .bind(userId, days, now)
    .run();
}
