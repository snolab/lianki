/**
 * MongoDB -> D1 migration: generates a SQL file to load into Cloudflare D1.
 *
 * READ-ONLY against MongoDB — see lib/migrate/runMigration.ts. Nothing mutates
 * the source database.
 *
 * Usage:
 *   bun scripts/migrate-mongo-to-d1.ts [--dry-run] [--replace] [--out=db/migration-data.sql]
 *
 * Then apply with:
 *   wrangler d1 migrations apply lianki --remote
 *   wrangler d1 execute lianki --remote --file=db/migration-data.sql
 *
 * `--replace` makes D1 match Mongo EXACTLY, deletions included. Without it the
 * load is additive: INSERT OR REPLACE can add and update but never remove, so
 * rows deleted in Mongo since the last load survive in D1 and return as live
 * cards at cutover. Use it for the pre-cutover load. Never use it once D1 is
 * the live backend.
 */

import { writeFileSync } from "fs";
import { MongoClient } from "mongodb";
import { generateMigrationSql } from "../lib/migrate/runMigration";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const replace = args.includes("--replace");
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
    const { sql, counts, warnings } = await generateMigrationSql(client.db(), { replace });

    console.log("Migration row counts:");
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
    for (const w of warnings) console.warn(`  WARNING: ${w}`);
    console.log(
      replace
        ? "\nmode: --replace — DELETEs every owned table first, so D1 ends up matching Mongo exactly"
        : "\nmode: additive — rows deleted in Mongo will REMAIN in D1 (pass --replace before a cutover)",
    );

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
