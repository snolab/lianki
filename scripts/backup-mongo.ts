/**
 * Full read-only backup of the MongoDB database to ./tmp/backup/.
 *
 * Each collection is written as Extended JSON (EJSON), which preserves BSON
 * types (ObjectId, Date, etc.) so the dump can be restored faithfully.
 *
 * Usage:  bun scripts/backup-mongo.ts [--out=tmp/backup]
 */

import { mkdirSync, writeFileSync } from "fs";
import { MongoClient } from "mongodb";
import { EJSON } from "bson";

const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="));
const outDir = outArg ? outArg.slice("--out=".length) : "tmp/backup";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set");
  process.exit(1);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const client = new MongoClient(uri!);
  await client.connect();
  try {
    const db = client.db();
    const collections = await db.listCollections().toArray();
    console.log(`Backing up ${collections.length} collections from "${db.databaseName}"`);

    const manifest: { collection: string; count: number; file: string }[] = [];
    for (const { name } of collections) {
      const docs = await db.collection(name).find({}).toArray();
      // `/` cannot appear in MongoDB collection names, so name is filename-safe.
      const file = `${name}.json`;
      writeFileSync(`${outDir}/${file}`, EJSON.stringify(docs, undefined, 2));
      manifest.push({ collection: name, count: docs.length, file });
      console.log(`  ${name}: ${docs.length} docs`);
    }

    writeFileSync(
      `${outDir}/_manifest.json`,
      JSON.stringify(
        { database: db.databaseName, backedUpAt: new Date().toISOString(), collections: manifest },
        null,
        2,
      ),
    );
    const total = manifest.reduce((n, c) => n + c.count, 0);
    console.log(`\nDone — ${total} documents across ${manifest.length} collections in ${outDir}/`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
