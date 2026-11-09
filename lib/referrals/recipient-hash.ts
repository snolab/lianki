import { canonicalEmail } from "@/lib/canonical-email";
import { sha256Hex } from "@/lib/security/throttle";

/**
 * An invite recipient's matching key: SHA-256 of the canonical address, never
 * the address (db/migrations/0061_invite_email.sql). Shared by the invite send
 * and the Resend webhook (lib/resend-webhook.ts), so a bounce lands on the same
 * row an invite checks.
 */
export const recipientHash = (email: string) => sha256Hex(`invite-email:${canonicalEmail(email)}`);
