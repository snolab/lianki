/**
 * The pure half of scripts/dev/permission.ts: arguments, and the statements a
 * command runs, from the same SQL as /dev/permissions (lib/account-permission.ts).
 */
import {
  SQL_AUDIT_GRANT,
  SQL_AUDIT_REVOKE,
  SQL_GRANT,
  SQL_LIST,
  SQL_REVOKE,
  validPermissionEmail,
} from "../../lib/account-permission";
import { PERMISSIONS, isPermission, type Permission } from "../../lib/permissions";

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
  | { cmd: "grant" | "revoke"; email: string; permissions: Permission[]; local: boolean };

const USAGE =
  "usage: permission.ts list | grant <email> <admin,dev> | revoke <email> <admin,dev> [--local]";

/** Throws with the usage or the problem. */
export function parseArgs(argv: string[]): Parsed {
  const local = argv.includes("--local");
  const [cmd, raw, perms, ...rest] = argv.filter((a) => a !== "--local");
  if (rest.length) throw new Error(USAGE);
  if (cmd === "list" && raw === undefined) return { cmd, local };
  if (cmd !== "grant" && cmd !== "revoke") throw new Error(USAGE);
  const email = validPermissionEmail(raw);
  if (!email) throw new Error(`not a complete address: ${raw ?? "(none)"}\n${USAGE}`);
  const list = (perms ?? "").split(",").filter(Boolean);
  if (!list.length || !list.every(isPermission))
    throw new Error(`permissions: a comma list of ${PERMISSIONS.join(", ")}\n${USAGE}`);
  return { cmd, email, permissions: [...new Set(list)] as Permission[], local };
}

/** The statements of one command, in order; wrangler runs them as one batch. */
export function commandSql(p: Parsed, now: number): string {
  if (p.cmd === "list") return SQL_LIST;
  // One millisecond apart per permission: each grant keeps its own audit row.
  return p.permissions
    .flatMap((perm, i) =>
      p.cmd === "grant"
        ? [
            inlineSql(SQL_GRANT, [p.email, perm, CLI_ACTOR, now + i]),
            inlineSql(SQL_AUDIT_GRANT, [p.email, perm, CLI_ACTOR, now + i]),
          ]
        : [
            inlineSql(SQL_REVOKE, [p.email, perm, now + i]),
            inlineSql(SQL_AUDIT_REVOKE, [p.email, perm, CLI_ACTOR, now + i]),
          ],
    )
    .join(";\n");
}
