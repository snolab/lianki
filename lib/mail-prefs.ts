/**
 * The device's copy of the mail switches (docs/mail-templates.md,
 * "Unsubscribe"): which kinds of mail the account turned off. Synced with the
 * account (`mail.*` in lib/prefs/schema.ts); the server reads the account's
 * value at every send (lib/mail-log/send.ts). Client-only helpers.
 */
import { notePrefWrite } from "@lianki/ui-state/account";

/** `mail.loginNotice`: the security notice after a sign-in from a new browser. */
export const MAIL_LOGIN_NOTICE_KEY = "lk:mail-login-notice";
/** Fired on window after this tab changed a mail switch. */
export const MAIL_PREFS_EVENT = "lk:mail-prefs";

/** On unless this device holds an explicit "0". */
export function readLoginNoticeOn(): boolean {
  try {
    return localStorage.getItem(MAIL_LOGIN_NOTICE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeLoginNoticeOn(on: boolean) {
  try {
    localStorage.setItem(MAIL_LOGIN_NOTICE_KEY, on ? "1" : "0");
  } catch {}
  notePrefWrite();
  try {
    window.dispatchEvent(new Event(MAIL_PREFS_EVENT));
  } catch {}
}
