/**
 * `user.email_canonical` on D1 (db/migrations/0043_email_canonical.sql): kept
 * up to date by the better-auth user hooks, and read by the once-per-person
 * checks — the trial, invites, gift codes. It never changes sign-in, and no
 * account is merged: two accounts that share it simply share those rewards.
 */
import { canonicalEmail } from "@/lib/canonical-email";
import type { D1Like } from "@/lib/d1/types";

/** Store the canonical form of `email` on the user (sign-up, email change). */
export async function setEmailCanonical(d1: D1Like, userId: string, email: string): Promise<void> {
  await d1
    .prepare("UPDATE user SET email_canonical = ?1 WHERE id = ?2")
    .bind(canonicalEmail(email), userId)
    .run();
}

export type SiblingRow = {
  id: string;
  createdAt: string;
  trialEndsAt: string | null;
  proEndsAt: string | null;
};

/**
 * Other accounts of the same person: the same canonical email, another id.
 * Fills the user's own column on the way, in case a hook missed it (an account
 * made before the migration's deploy, or by a script).
 */
export async function sameEmailAccounts(
  d1: D1Like,
  user: { id: string; email: string },
): Promise<SiblingRow[]> {
  const canonical = canonicalEmail(user.email);
  await d1
    .prepare(
      "UPDATE user SET email_canonical = ?1 WHERE id = ?2 AND (email_canonical IS NULL OR email_canonical != ?1)",
    )
    .bind(canonical, user.id)
    .run();
  const { results } = await d1
    .prepare(
      "SELECT id, createdAt, trialEndsAt, proEndsAt FROM user WHERE email_canonical = ?1 AND id != ?2",
    )
    .bind(canonical, user.id)
    .all<SiblingRow>();
  return results;
}
