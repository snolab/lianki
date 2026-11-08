#!/usr/bin/env bun
/**
 * Break-glass for the account permissions (docs/secrets-and-auth.md,
 * "Permissions"): the same statements as /dev/permissions, run through
 * wrangler d1, for when no admin can sign in. Needs this Mac's Cloudflare login
 * (`bunx wrangler login`); that login, not anything in the app, authorises it.
 *
 *   bun scripts/dev/permission.ts list
 *   bun scripts/dev/permission.ts grant someone@example.com admin,dev
 *   bun scripts/dev/permission.ts revoke someone@example.com dev
 *
 * Production by default; --local for the local D1. The last-admin guard holds
 * here as well. Changes are audited with the actor `cli`. Only on the owner's
 * approval: a grant is a security decision, not a setup step.
 */
import { SQL_LIST } from "../../lib/account-permission";
import { commandSql, parseArgs } from "./permission-sql";

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

const list = (local: boolean) => wrangler(SQL_LIST, local)[0]?.results ?? [];

if (import.meta.main) {
  try {
    const p = parseArgs(process.argv.slice(2));
    if (p.cmd !== "list") {
      wrangler(commandSql(p, Date.now()), p.local);
      const rows = list(p.local);
      for (const perm of p.permissions) {
        const active = rows.some((r) => r.email === p.email && r.permission === perm);
        if (p.cmd === "revoke" && active)
          console.error(`refused: ${p.email} is the only admin. Grant admin to another first.`);
        if (p.cmd === "grant" && !active) throw new Error(`${p.email} did not get ${perm}`);
        if (active === (p.cmd === "grant")) console.log(`${p.cmd} ${perm}: ${p.email}`);
      }
    }
    for (const r of list(p.local))
      console.log(`${r.email}\t${r.permission}\t${r.granted_by}\t${r.granted_at}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
