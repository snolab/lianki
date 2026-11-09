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
  | "box.bind"
  // A bind refused because the account is not on the my-box allowlist
  // (docs/box-oauth.md, "Who may have a box"). The list's own changes are
  // live-frontend.allow / live-frontend.disallow: it is the same list.
  | "box.bind-refused"
  | "box.revoke"
  // box:chat on an owner's box (docs/box-oauth.md, "Chat on the owner's box").
  | "box.chat-grant"
  | "box.chat-remove"
  | "box.chat-ticket"
  // box:eval on an owner's box (docs/box-oauth.md, "Code on the owner's box").
  | "box.eval-grant"
  | "box.eval-remove"
  | "email.change"
  // API tokens (lib/api-tokens.ts): made, revoked (one, or all with a sign-out
  // everywhere), used (at most once a minute per token, when last_used_at is
  // written), and refused for a known token (expired, missing the permission,
  // over its rate limit). Subject: the token's tag; detail: name and scopes.
  | "api-token.create"
  | "api-token.revoke"
  | "api-token.revoke-all"
  | "api-token.use"
  | "api-token.refused"
  // An eval token's every use: a sender connecting, and each eval it sends
  // (lib/eval-token.ts). Subject: the token's tag.
  | "api-token.eval"
  // Pre-grants (lib/referrals/pregrant.ts): Pro days given to an address before
  // it has an account. create/revoke: actor the admin, subject the row id,
  // detail a masked address and the days; direct: an existing account granted
  // at once (subject its id); claim: actor the account that signed in.
  | "pregrant.create"
  | "pregrant.revoke"
  | "pregrant.direct"
  | "pregrant.claim"
  // The old owner role (site_role, removed 2026-11-09): no longer written, kept
  // so its past rows still read as a known kind.
  // Mail templates (lib/mail-templates, docs/mail-templates.md): a version saved, a
  // version made active (rollback), a test mail sent to the editor himself.
  // Subject: "<template>:<locale>"; detail: the version.
  | "mail-template.save"
  | "mail-template.activate"
  | "mail-template.test-send"
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
