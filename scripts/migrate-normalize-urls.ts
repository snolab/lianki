#!/usr/bin/env tsx
/**
 * One-time migration: normalize all stored URLs.
 * - Strips tracking params (si, utm_*, fbclid, etc.)
 * - Normalizes m.* → www.* subdomains
 * - Converts youtu.be/ID → youtube.com/watch?v=ID
 * - Merges duplicate cards that collapse to the same URL
 *   (keeps the card with more reviews, or most recent if tied)
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI ?? (() => { throw new Error("missing MONGODB_URI"); })();
const client = new MongoClient(uri);

function normalizeUrl(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      u.hostname = "www.youtube.com";
      u.pathname = "/watch";
      u.searchParams.set("v", id);
    }
    if (u.hostname.startsWith("m.")) u.hostname = "www." + u.hostname.slice(2);
    for (const p of [
      "si", "pp", "feature", "ref", "source",
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "fbclid", "gclid", "mc_cid", "mc_eid", "igshid",
    ]) u.searchParams.delete(p);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return href;
  }
}

async function main() {
  await client.connect();
  const db = client.db();

  // Find all FSRSNotes collections (one per user: FSRSNotes@email)
  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => n.startsWith("FSRSNotes"));

  for (const colName of collections) {
    console.log(`\n── ${colName} ──`);
    const col = db.collection(colName);
    const notes = await col.find({}).toArray();

    let updated = 0;
    let merged = 0;
    let skipped = 0;

    for (const note of notes) {
      const normalized = normalizeUrl(note.url);
      if (normalized === note.url) { skipped++; continue; }

      // Check if a note with the normalized URL already exists
      const existing = await col.findOne({ url: normalized });

      if (!existing) {
        // Simple rename
        await col.updateOne({ _id: note._id }, { $set: { url: normalized } });
        console.log(`  renamed: ${note.url}\n       → ${normalized}`);
        updated++;
      } else {
        // Merge: keep the card with more reps; if tied, keep higher stability
        const keepOld =
          (note.card.reps ?? 0) > (existing.card.reps ?? 0) ||
          ((note.card.reps ?? 0) === (existing.card.reps ?? 0) &&
            (note.card.stability ?? 0) > (existing.card.stability ?? 0));

        const [winner, loser] = keepOld
          ? [note, existing]
          : [existing, note];

        await col.updateOne(
          { _id: winner._id },
          { $set: { url: normalized, ...(loser.title && !winner.title && { title: loser.title }) } },
        );
        await col.deleteOne({ _id: loser._id });
        console.log(`  merged: ${note.url}\n      + ${existing.url}\n      → ${normalized} (kept ${keepOld ? "old" : "existing"}, reps=${winner.card.reps})`);
        merged++;
      }
    }

    console.log(`  done: ${updated} renamed, ${merged} merged, ${skipped} unchanged`);
  }

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
