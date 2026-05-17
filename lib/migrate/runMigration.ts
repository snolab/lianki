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
  idOf,
} from "./mappers";

type Doc = Record<string, unknown>;

export type MigrationResult = {
  sql: string;
  counts: Record<string, number>;
  warnings: string[];
};

export async function generateMigrationSql(db: Db): Promise<MigrationResult> {
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
  const users = await db.collection("user").find({}).toArray();
  emit("user", users.map(userRow));

  const idByEmail = new Map<string, string>();
  for (const u of users) {
    if (typeof u.email === "string") idByEmail.set(u.email, idOf(u));
  }

  emit("session", (await db.collection("session").find({}).toArray()).map(sessionRow));
  emit("account", (await db.collection("account").find({}).toArray()).map(accountRow));
  emit(
    "verification",
    (await db.collection("verification").find({}).toArray()).map(verificationRow),
  );

  // ── per-user app collections ───────────────────────────────────────────────
  const collections = await db.listCollections().toArray();

  const noteRows: Doc[] = [];
  for (const c of collections) {
    if (!c.name.startsWith("FSRSNotes@")) continue;
    const email = c.name.slice("FSRSNotes@".length);
    const userId = idByEmail.get(email);
    if (!userId) {
      const n = await db.collection(c.name).countDocuments();
      warnings.push(`orphan FSRSNotes for unknown user ${email} (${n} notes skipped)`);
      continue;
    }
    for (const d of await db.collection(c.name).find({}).toArray()) {
      noteRows.push(fsrsNoteRow(userId, d));
    }
  }
  emit("fsrs_notes", noteRows);

  const goalRows: Doc[] = [];
  for (const c of collections) {
    if (!c.name.startsWith("RoadmapGoals@")) continue;
    const email = c.name.slice("RoadmapGoals@".length);
    const userId = idByEmail.get(email);
    if (!userId) {
      warnings.push(`orphan RoadmapGoals for unknown user ${email} (skipped)`);
      continue;
    }
    for (const d of await db.collection(c.name).find({}).toArray()) {
      goalRows.push(roadmapGoalRow(userId, d));
    }
  }
  emit("roadmap_goals", goalRows);

  emit("preferences", (await db.collection("preferences").find({}).toArray()).map(preferenceRow));
  emit("api_tokens", (await db.collection("ApiTokens").find({}).toArray()).map(apiTokenRow));

  const header =
    `-- Lianki MongoDB -> D1 data migration\n` +
    `-- Generated ${new Date().toISOString()}\n` +
    `-- Apply after db/migrations/0001_init.sql\n\n`;

  return { sql: header + sections.join("\n\n") + "\n", counts, warnings };
}
