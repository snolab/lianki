/**
 * What the send log (docs/mail-templates.md, "Send log") may keep of a mail's
 * variables, and which mails may be sent again. Pure and client-safe.
 *
 * Only the variables listed in STORED_VARS are ever written: an allow-list, so
 * a variable added to a template later is NOT stored until someone decides it
 * is safe. Sign-in codes, sign-in and confirm links, invite and opt-out links
 * hold secrets (or tokens) and are never stored; the detail view shows those
 * templates with placeholders instead.
 */
import { MAIL_TEMPLATES, isMailTemplateId, type MailTemplateId } from "@/lib/mail-templates/defs";

/** The Resend tag every mail carries: its mail_log id, echoed in webhook events. */
export const MAIL_LOG_TAG = "mail_log";

export const STORED_VARS: Record<MailTemplateId, readonly string[]> = {
  "signin-code": [],
  "signin-link": [],
  "login-notice": ["time", "location", "browser", "contactUrl"],
  "email-confirm": [],
  "email-taken": [],
  "email-requested": ["address", "contactUrl"],
  "email-changed": ["address", "contactUrl"],
  // `address` is the recipient: filled from the row when re-rendered.
  invite: ["inviter", "extraDays", "baseDays", "totalDays", "site", "contactUrl", "postal"],
};

/**
 * Mails never sent again from /dev/mails: a sign-in code or link, or a confirm
 * link, would be a fresh secret sent by someone other than its owner.
 */
export const NO_RESEND: ReadonlySet<string> = new Set([
  "signin-code",
  "signin-link",
  "email-confirm",
]);

const MAX_VALUE = 500;

/** The variables of `values` the log may keep for `template`, as strings; null when none. */
export function storedVars(
  template: string,
  values: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  if (!isMailTemplateId(template) || !values) return null;
  const out: Record<string, string> = {};
  for (const k of STORED_VARS[template]) {
    const v = values[k];
    if (v === null || v === undefined || v === "") continue;
    out[k] = String(v).slice(0, MAX_VALUE);
  }
  return Object.keys(out).length ? out : null;
}

/** A link that cannot be followed, naming the variable it stands for. */
export const placeholderUrl = (name: string) => `https://placeholder.invalid/${name}`;

/**
 * Values to re-render a logged mail: the stored ones, the recipient as
 * `address` for an invite, and a visible placeholder for every other variable
 * (`{name}`, or a placeholder link). `placeholders` lists those filled in.
 */
export function rerenderValues(
  template: MailTemplateId,
  stored: Record<string, string> | null,
  recipient: string,
): { values: Record<string, string>; placeholders: string[] } {
  const values: Record<string, string> = {};
  const placeholders: string[] = [];
  const allowed = new Set(STORED_VARS[template]);
  for (const [name, spec] of Object.entries(MAIL_TEMPLATES[template].vars)) {
    const v = allowed.has(name) ? stored?.[name] : undefined;
    if (v !== undefined) values[name] = v;
    else if (template === "invite" && name === "address") values[name] = recipient;
    else if (spec.required) {
      values[name] = spec.kind === "url" ? placeholderUrl(name) : `{${name}}`;
      placeholders.push(name);
    }
  }
  return { values, placeholders };
}

/** Parse a stored `vars` column; anything but a flat object of strings is dropped. */
export function parseVars(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
    return out;
  } catch {
    return null;
  }
}
