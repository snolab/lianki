#!/usr/bin/env bun
/**
 * Read-only: compare MongoDB with the remote D1 row by row. Exit 1 on any
 * discrepancy. Run after every Mongo→D1 load:
 *
 *   WRANGLER_NODE=~/.local/node-v22/bin/node bun --env-file=.env.local scripts/cutover/verify.ts
 *
 * Notes are compared against Mongo's BEST copy per (email, url) — the one the
 * migration keeps — so a load that kept a worse duplicate shows as differing.
 * Watch stats merge on load, so D1 passes when it holds at least the largest copy.
 */
import { MongoClient } from "mongodb";
import { d1Query } from "./d1";

type Doc = Record<string, any>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : "");
const score = (d: Doc) => [
  d.card?.reps ?? 0,
  (d.log ?? []).length,
  new Date(d.card?.due ?? 0).getTime(),
];
const better = (a: Doc, b: Doc) => {
  const [x, y] = [score(a), score(b)];
  return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0;
};
const sig = (card: Doc | null, logLen: number) => `${card?.reps ?? 0}|${iso(card?.due)}|${logLen}`;

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();
const db = client.db();
const mongoNotes = new Map<string, string>();
const mongoWatch = new Map<string, number>();
for (const { name } of await db.listCollections().toArray()) {
  if (name.startsWith("FSRSNotes@")) {
    const email = name.slice("FSRSNotes@".length);
    const best = new Map<string, Doc>();
    for (const d of await db.collection(name).find({}).toArray()) {
      const k = `${email} ${d.url}`;
      if (!best.has(k) || better(d, best.get(k)!)) best.set(k, d);
    }
    for (const [k, d] of best) mongoNotes.set(k, sig(d.card ?? null, (d.log ?? []).length));
  }
  if (name.startsWith("WatchStats@")) {
    const email = name.slice("WatchStats@".length);
    for (const d of await db.collection(name).find({}).toArray()) {
      const k = `${email} ${d.url}`;
      mongoWatch.set(k, Math.max(Number(d.wall ?? 0), mongoWatch.get(k) ?? 0));
    }
  }
}
await client.close();

const d1Notes = new Map<string, string>();
for (const r of d1Query<Doc>("SELECT email, url, card, log FROM fsrs_notes"))
  d1Notes.set(
    `${r.email} ${r.url}`,
    sig(JSON.parse(r.card ?? "null"), JSON.parse(r.log ?? "[]").length),
  );
const d1Watch = new Map<string, number>();
for (const r of d1Query<Doc>("SELECT email, url, wall FROM watch_stats"))
  d1Watch.set(`${r.email} ${r.url}`, Number(r.wall));

let bad = 0;
function report(
  label: string,
  keys: Set<string>,
  ok: (k: string) => boolean,
  show: (k: string) => string,
  a: number,
  b: number,
) {
  const fails = [...keys].filter((k) => !ok(k));
  console.log(`${label}: mongo ${a}, d1 ${b} | discrepancies ${fails.length}`);
  for (const k of fails.slice(0, 5)) console.log(`   ${k}  ${show(k)}`);
  bad += fails.length;
}
report(
  "notes",
  new Set([...mongoNotes.keys(), ...d1Notes.keys()]),
  (k) => mongoNotes.get(k) === d1Notes.get(k),
  (k) => `mongo=${mongoNotes.get(k)} d1=${d1Notes.get(k)}`,
  mongoNotes.size,
  d1Notes.size,
);
report(
  "watch",
  new Set([...mongoWatch.keys(), ...d1Watch.keys()]),
  (k) => mongoWatch.has(k) && d1Watch.has(k) && d1Watch.get(k)! >= mongoWatch.get(k)!,
  (k) => `mongo=${mongoWatch.get(k)} d1=${d1Watch.get(k)}`,
  mongoWatch.size,
  d1Watch.size,
);
console.log(bad ? `✗ ${bad} discrepancies` : "✓ D1 matches Mongo row-for-row");
process.exit(bad ? 1 : 0);
