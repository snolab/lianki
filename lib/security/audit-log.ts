/**
 * The security audit log (db/migrations/0040_security_audit.sql,
 * docs/security-measures.md, "Audit log"): one D1 row per write to what lets
 * dev code or a dev server in — the live-view pointer, dev access tokens, and
 * custom frontends (lib/live-view/custom.ts: a preview registered or revoked,
 * a user added to or removed from the allowlist).
 * Ids, kinds and labels only, never a token, a pointer or a secret.
 *
 * Best effort: a failed audit insert is logged and never undoes or blocks the
 * write it describes (the write has already happened; refusing it after the
 * fact would only lose it).
 */
export interface AuditDb {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

export type AuditKind =
  | "live-view.on"
  | "live-view.off"
  | "live-view.stop"
  | "dev-token.mint"
  | "dev-token.revoke"
  | "dev-token.revoke-all"
  | "dev-handoff.mint"
  | "live-preview.create"
  | "live-preview.revoke"
  | "live-frontend.allow"
  | "live-frontend.disallow"
  // Written by lib/site-role.ts in one batch with the role change; listed here
  // so the log's kinds are in one place.
  | "site-role.grant"
  | "site-role.revoke";

export type AuditEntry = {
  kind: AuditKind;
  /** Who: a user id, or "mac-key" for a pointer signed by the owner's Mac. */
  actor: string;
  /** What: a token id, a pointer serial. */
  subject?: string;
  /** A short label (branch@sha, an origin). Cut to 200 characters. */
  detail?: string;
};

export async function audit(db: AuditDb, e: AuditEntry, now = Date.now()): Promise<boolean> {
  try {
    await db
      .prepare(
        "INSERT INTO security_audit (at_ms, kind, actor, subject, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .bind(
        now,
        e.kind,
        e.actor.slice(0, 64),
        e.subject?.slice(0, 64) ?? null,
        e.detail?.slice(0, 200) ?? null,
      )
      .run();
    return true;
  } catch (err) {
    console.error(JSON.stringify({ event: "audit.failed", kind: e.kind, error: String(err) }));
    return false;
  }
}
