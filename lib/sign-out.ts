/**
 * Sign out from the browser: the menu's "Sign out" (AppShell, Header) and the
 * /auth/logout page all come here.
 *
 * The menu used to be a link to /auth/logout, a page outside app/(app)/ and
 * missing from APP_ROUTES, so the middleware sent it to /en/auth/logout: a 404,
 * and nobody was ever signed out (owner, 2026-11-05 02:59 JST, iPhone PWA).
 *
 * 0. Forget the user's own AI key on this device (`lk:byok`, docs/byok.md),
 *    first and whatever happens next: on a shared browser the next person must
 *    not find it, and an offline sign-out must not keep it. Owner's card,
 *    2026-11-06. Settings tells the user it will need entering again. The
 *    chat's last lines kept for an instant chat go too (lib/chat-cache.ts).
 * 1. POST better-auth's own /api/auth/sign-out, which deletes the session and
 *    answers with the session cookies expired (same-origin, so the Origin
 *    check passes; nothing about how sign-in works changes).
 * 2. Drop the service worker's page cache (public/sw.js caches every HTML page
 *    it serves, signed in), keeping only the word clips, which are not
 *    per-account. Offline, that cache could otherwise still open a signed-in
 *    shell.
 * 3. A hard navigation (location.replace) to the landing page: no client
 *    router cache or bfcache entry of a signed-in page is left to go back to.
 */
import { removeDevice } from "@/lib/byok/config";
import { exitOutputBed } from "@lianki/debug-chat/output-bed";
import { type BadgeNav, setBadge } from "@/lib/app-badge";
import { CLEAR_MARKER_LINE } from "@/lib/account-locale";
import { clearChatCache } from "@/lib/chat-cache";

export const SIGN_OUT_PATH = "/api/auth/sign-out";
/** public/sw.js KEEP_CACHES: the only cache that is not per-account. */
export const SIGN_OUT_KEEP_CACHES = ["lianki-audio-v1"];

type SignOutEnv = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  caches?: Pick<CacheStorage, "keys" | "delete">;
  replace: (url: string) => void;
  forgetByok?: () => void;
  /** The app-icon badge (docs/app-badge.md): cleared, it counted this account's cards. */
  badge?: BadgeNav | null;
  /** Ends the session instead of step 1: a box revokes its token at lianki.com. */
  endSession?: () => Promise<boolean>;
  /** Drops the `lang_src` marker: the next account's language is read afresh (lib/account-locale.ts). */
  forgetLocale?: () => void;
  /** Drops the chat's lines kept on the device (lib/chat-cache.ts). */
  forgetChat?: () => void;
};

let endSession: (() => Promise<boolean>) | undefined;

/**
 * On a box (docs/box-oauth.md) there is no cookie session: step 1 revokes the
 * box's token instead (BoxApiBridge sets this). Steps 0, 2 and 3 are the same.
 */
export function setSignOutSession(end: (() => Promise<boolean>) | undefined): void {
  endSession = end;
}

export async function signOut(to = "/", env?: SignOutEnv): Promise<boolean> {
  const e: SignOutEnv = env ?? {
    fetch: (url, init) => fetch(url, init),
    caches: typeof caches === "undefined" ? undefined : caches,
    replace: (url) => location.replace(url),
    forgetByok: () => removeDevice(),
    badge: typeof navigator === "undefined" ? null : (navigator as BadgeNav),
    endSession,
    forgetLocale: () => {
      document.cookie = CLEAR_MARKER_LINE;
    },
    forgetChat: () => clearChatCache(),
  };
  e.forgetByok?.();
  try {
    e.forgetChat?.();
  } catch {}
  try {
    e.forgetLocale?.();
  } catch {}
  void setBadge(e.badge, 0);
  // Nothing of the page's audio keeps running past the account (docs/voice-mode.md).
  exitOutputBed("sign-out");
  let ok = false;
  try {
    if (e.endSession) ok = await e.endSession();
    else {
      const r = await e.fetch(SIGN_OUT_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      ok = r.ok;
    }
  } catch {
    // Offline: the cookie stays; still leave, the next page shows who is signed in.
  }
  try {
    const keys = (await e.caches?.keys()) ?? [];
    await Promise.all(
      keys.filter((k) => !SIGN_OUT_KEEP_CACHES.includes(k)).map((k) => e.caches!.delete(k)),
    );
  } catch {
    // Cache storage can be unavailable (private mode); nothing to clear then.
  }
  e.replace(to);
  return ok;
}
