/**
 * MongoDB -> D1 migration: generates a SQL file to load into Cloudflare D1.
 *
 * READ-ONLY against MongoDB — see lib/migrate/runMigration.ts. Nothing mutates
 * the source database.
 *
 * Usage:
 *   bun scripts/migrate-mongo-to-d1.ts [--dry-run] [--out=db/migration-data.sql]
 *
 * Then apply with:
 *   wrangler d1 execute lianki --remote --file=db/migrations/0001_init.sql
 *   wrangler d1 execute lianki --remote --file=db/migration-data.sql
 */

import { writeFileSync } from "fs";
import { MongoClient } from "mongodb";
import { generateMigrationSql } from "@/lib/migrate/runMigration";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const outArg = args.find((a) => a.startsWith("--out="));
const outPath = outArg ? outArg.slice("--out=".length) : "db/migration-data.sql";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set");
  process.exit(1);
}

async function main() {
  const client = new MongoClient(uri!);
  await client.connect();
  try {
    const { sql, counts, warnings } = await generateMigrationSql(client.db());

    console.log("Migration row counts:");
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
    for (const w of warnings) console.warn(`  WARNING: ${w}`);

    if (dryRun) {
      console.log("\n--dry-run: no file written");
      return;
    }
    writeFileSync(outPath, sql);
    console.log(`\nWrote ${outPath}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
