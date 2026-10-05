// Core MongoDB -> D1 migration logic, separated from the CLI so it can be
// unit tested against an in-memory MongoDB. READ-ONLY: only find/listCollections.

import type { Db } from "mongodb";
import { mergeWatchStats, parseWatchStats, summarizeWatch } from "@lianki/core";
import { buildInserts } from "./sqlGen";
import {
  userRow,
  sessionRow,
  accountRow,
  verificationRow,
  fsrsNoteRow,
  roadmapGoalRow,
  preferenceRow,
  apiTokenRow,
  watchStatsRow,
  readMaterialRow,
} from "./mappers";

type Doc = Record<string, unknown>;

/** More reviews wins; then the longer log; then the later due date. */
function betterNote(a: Doc, b: Doc): boolean {
  const reps = (d: Doc) => Number((d.card as Doc | undefined)?.reps ?? 0);
  const logs = (d: Doc) => (Array.isArray(d.log) ? d.log.length : 0);
  const due = (d: Doc) => new Date(((d.card as Doc | undefined)?.due as Date) ?? 0).getTime() || 0;
  return (reps(a) - reps(b) || logs(a) - logs(b) || due(a) - due(b)) > 0;
}

/** Merge two watch_stats rows for the same (email, url) and re-derive the totals. */
function mergeWatchRows(a: Doc, b: Doc): Doc {
  const stats = mergeWatchStats(
    parseWatchStats(a.stats as string),
    parseWatchStats(b.stats as string),
  );
  const s = summarizeWatch(stats);
  return {
    ...a,
    stats: JSON.stringify(stats),
    wall: Math.round(s.wall),
    media: Math.round(s.media),
    lang: s.lang ?? a.lang ?? b.lang ?? null,
    title: a.title ?? b.title ?? null,
    last_seen: s.last ?? a.last_seen ?? b.last_seen ?? null,
  };
}

export type MigrationResult = {
  sql: string;
  counts: Record<string, number>;
  warnings: string[];
};

/**
 * Tables this migration owns, in an order safe to DELETE from: children before
 * the `user` rows they reference.
 */
const OWNED_TABLES = [
  "fsrs_notes",
  "watch_stats",
  "read_materials",
  "roadmap_goals",
  "preferences",
  "api_tokens",
  "session",
  "account",
  "verification",
  "user",
] as const;

export async function generateMigrationSql(
  db: Db,
  opts: { replace?: boolean } = {},
): Promise<MigrationResult> {
  const sections: string[] = [];
  const counts: Record<string, number> = {};
  const warnings: string[] = [];

  function emit(table: string, rows: Doc[]) {
    counts[table] = rows.length;
    if (rows.length > 0) {
      sections.push(`-- ${table} (${rows.length})\n${buildInserts(table, rows)}`);
    }
  }

  // ── auth tables ────────────────────────────────────────────────────────────
  emit("user", (await db.collection("user").find({}).toArray()).map(userRow));
  emit("session", (await db.collection("session").find({}).toArray()).map(sessionRow));
  emit("account", (await db.collection("account").find({}).toArray()).map(accountRow));
  emit(
    "verification",
    (await db.collection("verification").find({}).toArray()).map(verificationRow),
  );

  // ── per-user app collections (keyed by the email in the collection name) ───
  const collections = await db.listCollections().toArray();

  // Mongo has no unique index on url, so a write race can leave two docs for one
  // card. D1's (email, url) key keeps exactly one, and with INSERT OR REPLACE
  // that was whichever came last — measured on the live data, the worse copy
  // every time (8 reps kept over 9). Pick the winner explicitly instead.
  const notes = new Map<string, { email: string; doc: Doc }>();
  for (const c of collections) {
    if (!c.name.startsWith("FSRSNotes@")) continue;
    const email = c.name.slice("FSRSNotes@".length);
    if (!email) {
      warnings.push(`skipped FSRSNotes collection with empty email suffix: ${c.name}`);
      continue;
    }
    for (const d of await db.collection(c.name).find({}).toArray()) {
      const key = `${email}\n${String(d.url)}`;
      const prev = notes.get(key);
      if (prev)
        warnings.push(`duplicate note ${email} ${String(d.url)}: kept the more-reviewed copy`);
      if (!prev || betterNote(d, prev.doc)) notes.set(key, { email, doc: d });
    }
  }
  emit(
    "fsrs_notes",
    [...notes.values()].map(({ email, doc }) => fsrsNoteRow(email, doc)),
  );

  const goalRows: Doc[] = [];
  for (const c of collections) {
    if (!c.name.startsWith("RoadmapGoals@")) continue;
    const email = c.name.slice("RoadmapGoals@".length);
    if (!email) {
      warnings.push(`skipped RoadmapGoals collection with empty email suffix: ${c.name}`);
      continue;
    }
    for (const d of await db.collection(c.name).find({}).toArray()) {
      goalRows.push(roadmapGoalRow(email, d));
    }
  }
  emit("roadmap_goals", goalRows);

  // Watch time is a separate per-email collection from the notes; leaving it out
  // dropped every user's watch history at cutover.
  // Duplicates here are merged rather than picked: the stats are a per-device
  // grow-only CRDT, so merging the copies loses nothing and counts nothing twice.
  const watch = new Map<string, Doc>();
  for (const c of collections) {
    if (!c.name.startsWith("WatchStats@")) continue;
    const email = c.name.slice("WatchStats@".length);
    if (!email) {
      warnings.push(`skipped WatchStats collection with empty email suffix: ${c.name}`);
      continue;
    }
    for (const d of await db.collection(c.name).find({}).toArray()) {
      if (!d.url) {
        warnings.push(`skipped WatchStats doc without url in ${c.name}`);
        continue;
      }
      const row = watchStatsRow(email, d);
      const key = `${email}\n${String(d.url)}`;
      const prev = watch.get(key);
      if (prev) warnings.push(`duplicate watch stats ${email} ${String(d.url)}: merged`);
      watch.set(key, prev ? mergeWatchRows(prev, row) : row);
    }
  }
  emit("watch_stats", [...watch.values()]);

  // Materials whose content lives in GridFS would need an R2 copy; warn rather
  // than load a row whose body is missing.
  const materials = await db.collection("readMaterials").find({}).toArray();
  for (const d of materials) {
    if (d.content == null) {
      warnings.push(`readMaterials ${String(d._id)} has no inline content (GridFS?), not migrated`);
    }
  }
  emit("read_materials", materials.filter((d) => d.content != null).map(readMaterialRow));

  emit("preferences", (await db.collection("preferences").find({}).toArray()).map(preferenceRow));
  emit("api_tokens", (await db.collection("ApiTokens").find({}).toArray()).map(apiTokenRow));

  const header =
    `-- Lianki MongoDB -> D1 data migration\n` +
    `-- Generated ${new Date().toISOString()}\n` +
    `-- Apply after the migrations in db/migrations (wrangler d1 migrations apply)\n\n`;

  // Deletions do not replicate through INSERT OR REPLACE.
  //
  // The load can add and update, never remove — so every row deleted in Mongo
  // since the previous load stays in D1 forever, and at cutover comes back as a
  // live card. Measured on the real database: 26 such rows, 4 of them the
  // LinkedIn cards the user had deleted repeatedly. Refreshing "idempotently"
  // did not converge; it only ever grew.
  //
  // Opt-in rather than default: this is destructive, and once D1 is the live
  // backend an accidental run would wipe writes Mongo never saw.
  const truncate = opts.replace
    ? `-- FULL REFRESH: make D1 match Mongo exactly, including deletions.\n` +
      OWNED_TABLES.map((t) => `DELETE FROM ${t};`).join("\n") +
      `\n\n`
    : "";

  return { sql: header + truncate + sections.join("\n\n") + "\n", counts, warnings };
}
