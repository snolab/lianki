import { isSessionTag, isUserId, sessionTag } from "@/lib/dev-eval";

/**
 * Is the owner's sign-in session with this tag still live? Asked by
 * lianki-push's debug hub right before it renews an eval grant bound to it
 * (docs/monitoring.md, "Renewal"), so a sign-out whose notice was lost still
 * stops renewal. Only the owner's sessions can ever be live here; anything
 * else, or an id that is not a session tag, is `false`. The tag is a SHA-256
 * of a session id: unguessable, so the answer tells a stranger nothing.
 */
export type SessionLookup = {
  /** The user's email, or null if there is no such user. */
  emailOf(userId: string): Promise<string | null>;
  /** The user's sessions: id and expiry. */
  sessionsOf(userId: string): Promise<{ id: string; expiresAt: Date | string | number }[]>;
  isOwner(email: string | null | undefined): boolean;
  now?: () => number;
};

export async function sessionLive(user: unknown, tag: unknown, db: SessionLookup) {
  if (!isUserId(user) || !isSessionTag(tag)) return false;
  if (!db.isOwner(await db.emailOf(user))) return false;
  const t = (db.now ?? Date.now)();
  for (const s of await db.sessionsOf(user))
    if (new Date(s.expiresAt).getTime() > t && (await sessionTag(s.id)) === tag) return true;
  return false;
}
