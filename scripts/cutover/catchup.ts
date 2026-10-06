#!/usr/bin/env bun
/**
 * Post-cutover catch-up: bring MongoDB writes made after T0 (the start of the
 * final Mongo→D1 load) into D1, without ever replacing a newer D1 row. Covers
 * the minutes in which some clients still reach Vercel while DNS settles.
 * MongoDB is only read.
 *
 *   bun --env-file=.env.local scripts/cutover/catchup.ts <T0-iso>               # dry run
 *   bun --env-file=.env.local scripts/cutover/catchup.ts <T0-iso> --out=f.sql   # + SQL to apply
 *
 * Rules: a note created after T0 and missing in D1 is inserted; a note both
 * sides have is replaced only when Mongo's newest review is newer than D1's;
 * speed markers that differ are copied from Mongo; watch stats merge via the
 * grow-only mergeWatchStats. Deletions are reported, never applied.
 * Needs WRANGLER_NODE pointing at Node >= 22 (see ./d1.ts).
 */
import { writeFileSync } from "fs";
import { MongoClient } from "mongodb";
import { mergeWatchStats, parseWatchStats, summarizeWatch } from "@lianki/core";
import { fsrsNoteRow, watchStatsRow } from "../../lib/migrate/mappers";
import { buildInserts } from "../../lib/migrate/sqlGen";
import { d1Query } from "./d1";

type Doc = Record<string, any>;
const T0 = new Date(process.argv[2] ?? "");
if (isNaN(+T0)) throw new Error("usage: catchup.ts <T0-iso> [--out=file.sql]");
const out = process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length);

const lastReview = (log: Doc[] = []) =>
  Math.max(0, ...log.map((l) => new Date(l.review ?? 0).getTime() || 0));
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const key = (email: string, url: unknown) => `${email} ${String(url)}`;

const d1Logs = new Map<string, Doc[]>();
const d1Markers = new Map<string, string>();
for (const r of d1Query<Doc>("SELECT email, url, log, speed_markers FROM fsrs_notes")) {
  d1Logs.set(key(r.email, r.url), JSON.parse(r.log || "[]"));
  d1Markers.set(key(r.email, r.url), r.speed_markers ?? "null");
}
const d1Watch = new Map<string, Doc>();
for (const r of d1Query<Doc>("SELECT * FROM watch_stats")) d1Watch.set(key(r.email, r.url), r);

const noteRows: Doc[] = [];
const watchRows: Doc[] = [];
const updates: string[] = [];
const report: string[] = [];
const mongoKeys = new Set<string>();

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();
const db = client.db();
for (const { name } of await db.listCollections().toArray()) {
  if (name.startsWith("FSRSNotes@")) {
    const email = name.slice("FSRSNotes@".length);
    for (const d of await db.collection(name).find({}).toArray()) {
      const k = key(email, d.url);
      mongoKeys.add(k);
      const mLast = lastReview(d.log);
      const touched = d._id.getTimestamp() >= T0 || mLast >= +T0;
      const markers = JSON.stringify(d.speedMarkers ?? null);
      if (!touched && d.speedMarkers && d1Logs.has(k) && markers !== d1Markers.get(k)) {
        updates.push(
          `UPDATE fsrs_notes SET speed_markers = ${q(markers)} WHERE email = ${q(email)} AND url = ${q(String(d.url))};`,
        );
        report.push(`~ marks ${k}`);
      }
      if (!touched) continue;
      if (!d1Logs.has(k)) {
        noteRows.push(fsrsNoteRow(email, d));
        report.push(`+ note  ${k}`);
      } else if (mLast > lastReview(d1Logs.get(k))) {
        noteRows.push(fsrsNoteRow(email, d));
        report.push(`~ note  ${k}  (Mongo reviewed later)`);
      } else report.push(`= note  ${k}  (D1 newer, kept)`);
    }
  }
  if (name.startsWith("WatchStats@")) {
    const email = name.slice("WatchStats@".length);
    for (const d of await db.collection(name).find({}).toArray()) {
      if (!d.url || !(new Date(d.lastSeen ?? 0) >= T0)) continue;
      const k = key(email, d.url);
      const m = watchStatsRow(email, d) as Doc;
      const e = d1Watch.get(k);
      if (!e) {
        watchRows.push(m);
        report.push(`+ watch ${k}`);
        continue;
      }
      const stats = mergeWatchStats(parseWatchStats(e.stats), parseWatchStats(m.stats));
      const s = summarizeWatch(stats);
      watchRows.push({
        ...e,
        stats: JSON.stringify(stats),
        wall: Math.round(s.wall),
        media: Math.round(s.media),
        last_seen: s.last ?? e.last_seen,
      });
      report.push(`~ watch ${k}  (merged)`);
    }
  }
}
await client.close();

for (const k of d1Logs.keys())
  if (!mongoKeys.has(k))
    report.push(
      `? note  ${k}  in D1 only (created after switch, or deleted on Mongo) — left as is`,
    );

console.log(
  `T0=${T0.toISOString()}  notes ${noteRows.length}, watch ${watchRows.length}, marker updates ${updates.length}`,
);
for (const line of report) console.log("  " + line);
if (out) {
  const sql = [
    noteRows.length ? buildInserts("fsrs_notes", noteRows) : "",
    watchRows.length ? buildInserts("watch_stats", watchRows) : "",
    ...updates,
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(out, sql + "\n");
  console.log(`wrote ${out}`);
}
