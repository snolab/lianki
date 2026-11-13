/**
 * Which client sent a token request, for the security audit log only
 * (docs/api-for-agents.md, "Connect via MCP"). `lianki mcp`
 * (packages/lianki-cli/mcp.mjs) sends `x-lianki-client: mcp/<version>
 * tool=<tool name>` on every call; the `api-token.use` row then ends with
 * `via mcp/<version> <tool>`. Never the arguments, never the token.
 *
 * Only that exact shape is kept: anything else in the header is dropped, so
 * the header cannot write arbitrary text into the log.
 */
import { tagOf, type CheckResult } from "@/lib/api-tokens";
import { type AuditDb, audit } from "@/lib/security/audit-log";

export const CLIENT_HEADER = "x-lianki-client";
const CLIENT_RE =
  /^(mcp(?:-remote)?)\/(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9a-z.]{1,20})?) tool=(lianki_[a-z_]{1,32})$/;

/** `mcp/0.4.0 lianki_due` (or `mcp-remote/1.0.0 lianki_due`) from a well-formed header value, else null. */
export function clientOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const m = CLIENT_RE.exec(raw.trim());
  return m ? `${m[1]}/${m[2]} ${m[3]}` : null;
}

/**
 * A card or settings request by a named client: one `api-token.use` row when
 * the check wrote last_used_at (at most once a minute per token, like the
 * chat's). A request without the header writes nothing here.
 */
export async function auditClientUse(
  db: AuditDb,
  r: CheckResult,
  client: string | null,
  what: string,
  now = Date.now(),
): Promise<void> {
  if (!client || !r.ok || !r.touched) return;
  await audit(
    db,
    {
      kind: "api-token.use",
      actor: r.user.id,
      subject: tagOf(r.id),
      detail: `${what} ${r.name} via ${client}`,
    },
    now,
  );
}
