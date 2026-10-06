// Shared helper for the cutover scripts: run one SQL statement against the
// remote `lianki` D1 and return its rows. wrangler needs Node >= 22; point
// WRANGLER_NODE at one if the default `node` is older.
import { spawnSync } from "child_process";

export function d1Query<T = Record<string, unknown>>(sql: string): T[] {
  const node = process.env.WRANGLER_NODE ?? "node";
  const args = [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "lianki",
    "--remote",
    "--json",
    "--command",
    sql,
  ];
  const r = spawnSync(node, args, { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout)[0].results as T[];
}
