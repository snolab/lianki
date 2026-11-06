#!/usr/bin/env bun
/**
 * Break-glass for the owner role (docs/secrets-and-auth.md, "The owner role"):
 * the same statements as /dev/owners, run through wrangler d1, for when no
 * owner can sign in. Needs this Mac's Cloudflare login (`bunx wrangler login`);
 * that login, not anything in the app, is what authorises it.
 *
 *   bun scripts/dev/owner-role.ts list
 *   bun scripts/dev/owner-role.ts grant someone@example.com
 *   bun scripts/dev/owner-role.ts revoke someone@example.com
 *
 * Production by default; --local for the local D1. The last-owner guard holds
 * here as well: to replace the only owner, grant the new one first. Changes are
 * audited with the actor `cli`.
 */
import { commandSql, parseArgs } from "./owner-role-sql";
import { SQL_LIST } from "../../lib/site-role";

function wrangler(sql: string, local: boolean): { results?: Record<string, unknown>[] }[] {
  const r = Bun.spawnSync(
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      "lianki",
      local ? "--local" : "--remote",
      "--json",
      "--command",
      sql,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  if (r.exitCode !== 0) throw new Error(`wrangler exited ${r.exitCode}`);
  return JSON.parse(r.stdout.toString());
}

function list(local: boolean): Record<string, unknown>[] {
  return wrangler(SQL_LIST, local)[0]?.results ?? [];
}

if (import.meta.main) {
  try {
    const p = parseArgs(process.argv.slice(2));
    if (p.cmd !== "list") {
      wrangler(commandSql(p, Date.now()), p.local);
      const active = list(p.local).some((o) => o.email === p.email);
      if (p.cmd === "revoke" && active) {
        console.error(`refused: ${p.email} is the only active owner. Grant another first.`);
        process.exit(1);
      }
      if (p.cmd === "grant" && !active) throw new Error(`${p.email} did not become an owner`);
      console.log(`${p.cmd}: ${p.email}`);
    }
    for (const o of list(p.local)) console.log(`${o.email}\t${o.granted_by}\t${o.granted_at}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
