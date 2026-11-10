// POST /api/contact (app/api/contact/route.ts): a public form, no sign-in, so
// it is throttled per IP and overall (D1), its body is capped, and what the
// sender types reaches Slack escaped and unformatted.
import { escapeSlack } from "@/lib/security/escape";

/**
 * Four fields of up to config `contact.fieldMax` characters each (lib/config.ts,
 * at most 2600), at up to 3 UTF-8 bytes a character, with room for JSON.
 */
export const CONTACT_BODY_MAX = 32 * 1024;
const HOUR = 60 * 60_000;
/** Messages per IP, and from everyone together. */
export const CONTACT_PER_IP = { max: 5, windowMs: HOUR };
export const CONTACT_GLOBAL = { max: 60, windowMs: HOUR };

/**
 * The Slack text for one message. Every user value is escaped (no labelled
 * links, mentions or channel references), and the route sends it with
 * `mrkdwn: false` and no unfurling. A bare URL in the text may still show as
 * a link: Slack does that by itself.
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
