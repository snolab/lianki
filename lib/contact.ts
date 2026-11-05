// POST /api/contact (app/api/contact/route.ts): a public form, no sign-in, so
// it is throttled per IP and overall (D1), its body is capped, and what the
// sender types reaches Slack escaped and unformatted.
import { escapeSlack } from "@/lib/security/escape";

/** Four fields of at most 2000 characters each fit in this, with room for JSON. */
export const CONTACT_BODY_MAX = 16 * 1024;
export const CONTACT_FIELD_MAX = 2000;
const HOUR = 60 * 60_000;
/** Messages per IP, and from everyone together. */
export const CONTACT_PER_IP = { max: 5, windowMs: HOUR };
export const CONTACT_GLOBAL = { max: 60, windowMs: HOUR };

/**
 * The Slack text for one message. Every user value is escaped (no links,
 * mentions or channel references), and the route sends it with
 * `mrkdwn: false`, so nothing the sender types is formatted either.
 */
export function contactSlackText(f: {
  name: string;
  email: string;
  phone?: string;
  message?: string;
}): string {
  return [
    "New Contact from Lianki",
    `Name: ${escapeSlack(f.name)}`,
    `Email: ${escapeSlack(f.email)}`,
    `Phone: ${escapeSlack(f.phone || "N/A")}`,
    `Message: ${escapeSlack(f.message || "N/A")}`,
  ].join("\n");
}
