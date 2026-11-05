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
import {
  SQL_AUDIT_GRANT,
  SQL_AUDIT_REVOKE,
  SQL_GRANT,
  SQL_LIST,
  SQL_REVOKE,
  validOwnerEmail,
} from "../../lib/site-role";

export const CLI_ACTOR = "cli";

/** Put values into a statement's ?N slots, for wrangler's --command (one pass, quoted). */
export function inlineSql(sql: string, params: (string | number)[]): string {
  return sql.replace(/\?(\d+)/g, (_, n) => {
    const v = params[Number(n) - 1];
    if (typeof v === "number") return String(Math.trunc(v));
    if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
    throw new Error(`no value for ?${n}`);
  });
}

export type Parsed =
  | { cmd: "list"; local: boolean }
  | { cmd: "grant" | "revoke"; email: string; local: boolean };

/** Throws with the usage or the problem. */
export function parseArgs(argv: string[]): Parsed {
  const local = argv.includes("--local");
  const [cmd, raw, ...rest] = argv.filter((a) => a !== "--local");
  const usage = "usage: owner-role.ts list | grant <email> | revoke <email> [--local]";
  if (rest.length) throw new Error(usage);
  if (cmd === "list" && raw === undefined) return { cmd, local };
  if (cmd !== "grant" && cmd !== "revoke") throw new Error(usage);
  const email = validOwnerEmail(raw);
  if (!email) throw new Error(`not a complete address: ${raw ?? "(none)"}\n${usage}`);
  return { cmd, email, local };
}

/** The statements of one command, in order; wrangler runs them as one batch. */
export function commandSql(p: Parsed, now: number): string {
  if (p.cmd === "list") return SQL_LIST;
  if (p.cmd === "grant")
    return [
      inlineSql(SQL_GRANT, [p.email, CLI_ACTOR, now]),
      inlineSql(SQL_AUDIT_GRANT, [p.email, CLI_ACTOR, now]),
    ].join(";\n");
  return [
    inlineSql(SQL_REVOKE, [p.email, now]),
    inlineSql(SQL_AUDIT_REVOKE, [p.email, CLI_ACTOR, now]),
  ].join(";\n");
}

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
