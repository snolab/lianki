/**
 * May this audio line be posted (`say --play`; docs/li-sound-hub.md, "Playing
 * audio from an agent")? Asked by lianki-push's hub, over the SESSIONS
 * binding (DebugSessions.playAudio, worker.ts), before it posts a line with
 * `audio`. The hub has already parsed the src (play-audio.ts parsePlay); it
 * sends only the host and the kind, never the URL, and nothing here fetches it.
 *
 * Deny by default:
 * - the flag `chat.play-audio` (audience owner) must be on;
 * - the host must not be on the cfg deny list `chat.play.denyHosts`;
 * - a lane token needs `chat:play`, and its account the `dev` grant (the
 *   flag's audience, lib/permissions.ts; never an email in code);
 * - per token (or per sender for the grant path), `chat.play.perTenMin` lines
 *   in 10 minutes (D1, so isolates cannot walk around it).
 * Every allowed play is in the security audit log (`chat.play`): who, the
 * host, the kind. A refusal of a known token is audited as api-token.refused.
 */
import { checkToken, tagOf } from "@/lib/api-tokens";
import { readHolders, type PermissionReadDb } from "@/lib/account-permission";
import { normalizeEmail } from "@/lib/permissions";
import { type AuditDb, audit } from "@/lib/security/audit-log";
import { hit, type ThrottleDb } from "@/lib/security/throttle";
import { configLive, flagLive, type SessionDb } from "@/lib/debug-session";
import type { D1Like } from "@/lib/d1/types";
import {
  PLAY_FLAG,
  PLAY_KINDS_NOW,
  denyList,
  hostDenied,
} from "@/packages/debug-chat/src/play-audio";

export { PLAY_FLAG };
const WINDOW_MS = 10 * 60_000;

export type PlayCheckRequest =
  | { via: "grant"; label?: string; host: string; kind: string }
  | { via: "token"; token?: string; tokenHash?: string; host: string; kind: string };

export type PlayCheckAnswer =
  | { ok: true }
  | {
      ok: false;
      error: "bad request" | "flag" | "denied" | "unknown" | "expired" | "scope" | "rate";
      retryAfterMs?: number;
    };

export type PlayCheckDb = D1Like & SessionDb & ThrottleDb & AuditDb & PermissionReadDb;

const HOST = /^[a-z0-9.-]{1,253}$/;

export async function playCheck(
  db: PlayCheckDb,
  raw: unknown,
  now = Date.now(),
): Promise<PlayCheckAnswer> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const host = typeof r.host === "string" ? r.host.toLowerCase() : "";
  const kind = r.kind;
  if (!HOST.test(host) || !(PLAY_KINDS_NOW as readonly unknown[]).includes(kind))
    return { ok: false, error: "bad request" };
  if (r.via !== "grant" && r.via !== "token") return { ok: false, error: "bad request" };
  if (!(await flagLive(db, PLAY_FLAG))) return { ok: false, error: "flag" };
  const deny = denyList((await configLive(db, "chat.play.denyHosts")) as string);
  if (hostDenied(host, deny)) return { ok: false, error: "denied" };
  const max = Number(await configLive(db, "chat.play.perTenMin"));
  const limit = { max: Number.isFinite(max) ? max : 0, windowMs: WINDOW_MS };

  if (r.via === "grant") {
    const label = typeof r.label === "string" ? r.label.slice(0, 80) : "grant";
    const l = await hit(db, "chat-play:grant", limit, now);
    if (!l.allowed) return { ok: false, error: "rate", retryAfterMs: l.retryAfterMs };
    await audit(
      db,
      { kind: "chat.play", actor: "grant", subject: host, detail: `${kind} ${label}` },
      now,
    );
    return { ok: true };
  }

  const byHash = r.tokenHash !== undefined;
  const cred = byHash ? r.tokenHash : r.token;
  if (typeof cred !== "string" || (byHash && r.token !== undefined))
    return { ok: false, error: "bad request" };
  const c = await checkToken(db, cred, "chat:play", now, { byHash });
  if (!c.ok) {
    if (c.reason === "malformed") return { ok: false, error: "bad request" };
    if (c.id && c.userId)
      await audit(
        db,
        {
          kind: "api-token.refused",
          actor: c.userId,
          subject: tagOf(c.id),
          detail: `chat play ${c.reason}`,
        },
        now,
      );
    return { ok: false, error: c.reason === "unknown" ? "unknown" : c.reason };
  }
  // The flag's audience: holders of `dev`, straight from D1.
  const devs = await readHolders(db, "dev");
  if (!devs.includes(normalizeEmail(c.user.email))) return { ok: false, error: "flag" };
  const l = await hit(db, `chat-play:${tagOf(c.id)}`, limit, now);
  if (!l.allowed) return { ok: false, error: "rate", retryAfterMs: l.retryAfterMs };
  await audit(
    db,
    { kind: "chat.play", actor: c.user.id, subject: host, detail: `${kind} token ${c.name}` },
    now,
  );
  return { ok: true };
}
