/**
 * The pure half of scripts/dev/owner-role.ts: arguments, and the statements a
 * command runs, from the same SQL as /dev/owners (lib/site-role.ts).
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
