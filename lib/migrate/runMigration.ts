// Core MongoDB -> D1 migration logic, separated from the CLI so it can be
// unit tested against an in-memory MongoDB. READ-ONLY: only find/listCollections.

import type { Db } from "mongodb";
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
} from "./mappers";

type Doc = Record<string, unknown>;

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

  const noteRows: Doc[] = [];
  for (const c of collections) {
    if (!c.name.startsWith("FSRSNotes@")) continue;
    const email = c.name.slice("FSRSNotes@".length);
    if (!email) {
      warnings.push(`skipped FSRSNotes collection with empty email suffix: ${c.name}`);
      continue;
    }
    for (const d of await db.collection(c.name).find({}).toArray()) {
      noteRows.push(fsrsNoteRow(email, d));
    }
  }
  emit("fsrs_notes", noteRows);

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
