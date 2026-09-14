import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * The full D1 schema: every migration, in order.
 *
 * Tests used to read `0001_init.sql` alone, which silently drifts — adding a
 * migration made unrelated suites fail against a schema that no deployment has
 * had since. Reading the directory means a new migration is picked up by every
 * test without touching any of them.
 */
export function testSchema(dir = "db/migrations"): string {
  const root = join(process.cwd(), dir);
  return readdirSync(root)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(root, f), "utf8"))
    .join("\n");
}
