/**
 * The app-icon badge of the installed web app (docs/app-badge.md): a number on
 * Lianki's home-screen / dock icon, through the Badging API
 * (`navigator.setAppBadge` / `clearAppBadge`; the service worker's
 * `self.navigator` in public/sw.js).
 *
 * What it counts is the synced preference `notify.badge`
 * (docs/prefs-sync.md), kept on the device in `lk:notify-badge`:
 *
 * - `off`        nothing, the badge is cleared;
 * - `ask-cards`  Li's ask cards in this account's chat still unanswered;
 * - `due-cards`  cards due now: page cards and /words words;
 * - `both`       (default) the sum.
 *
 * Behind the flag `pwa.app-badge` (the server says; never the client).
 * No Badging API (most desktop browsers outside an installed app, iOS before
 * 16.4 or outside a home-screen app): nothing happens, silently.
 */
import { notePrefWrite } from "@lianki/ui-state/account";

export const BADGE_MODES = ["off", "ask-cards", "due-cards", "both"] as const;
export type BadgeMode = (typeof BADGE_MODES)[number];
export const BADGE_DEFAULT: BadgeMode = "both";

/** The device's copy of `notify.badge` (lib/prefs/bindings.ts). */
export const BADGE_PREF_KEY = "lk:notify-badge";
/** Fired on window when this tab changed the mode (the settings row and AppBadge re-read). */
export const BADGE_MODE_EVENT = "lk:badge-mode";
/**
 * Fired on window when the user dealt with something the badge counts:
 * detail `{ asks?: -1, due?: -1 }` lowers the number at once, `{ refresh: true }`
 * asks the server again (the review queue just ran out).
 */
export const BADGE_SEEN_EVENT = "lk:badge-seen";

/** The counts endpoint (app/api/badge/route.ts). */
export const BADGE_ENDPOINT = "/api/badge";
/** At most one counts fetch per tab in this long, unless something was seen. */
export const BADGE_MIN_FETCH_MS = 30_000;
/** An ask card older than this no longer counts (an ask expires within 7 days at most). */
export const ASK_WINDOW_MS = 7 * 24 * 3600_000;
/** The badge never shows more than this. */
export const BADGE_MAX = 9999;

export type BadgeCounts = { asks: number; due: number };
export type BadgeDelta = { asks?: number; due?: number; refresh?: boolean };

export const isBadgeMode = (v: unknown): v is BadgeMode =>
  typeof v === "string" && (BADGE_MODES as readonly string[]).includes(v);

/** A stored or sent mode; anything else is the default. */
export const parseBadgeMode = (v: unknown): BadgeMode => (isBadgeMode(v) ? v : BADGE_DEFAULT);

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), BADGE_MAX) : null;

/** `{asks, due}` as the endpoint or a push sends them, or null. */
export function parseCounts(v: unknown): BadgeCounts | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const asks = count(r.asks);
  const due = count(r.due);
  return asks === null || due === null ? null : { asks, due };
}

/** What the open screen already shows: its part of the badge counts as seen. */
export type Seen = { asks?: boolean; due?: boolean };

/**
 * The screens that show a part of the badge: /review and /words (cards due),
 * /chat (the chat history, where the asks are). The locale prefix is allowed.
 */
export function seenOn(pathname: string | null | undefined): Seen {
  const p = (pathname ?? "").replace(/^\/[a-z]{2}(?=\/|$)/, "") || "/";
  const under = (base: string) => p === base || p.startsWith(`${base}/`);
  return { due: under("/review") || under("/words"), asks: under("/chat") };
}

/** The number on the icon: 0 clears it. */
export function badgeCount(mode: BadgeMode, c: BadgeCounts | null, seen: Seen = {}): number {
  if (!c || mode === "off") return 0;
  const asks = mode === "due-cards" || seen.asks ? 0 : c.asks;
  const due = mode === "ask-cards" || seen.due ? 0 : c.due;
  return Math.min(asks + due, BADGE_MAX);
}

/** Counts after something was dealt with on this device; never below 0. */
export function applyDelta(c: BadgeCounts, d: BadgeDelta): BadgeCounts {
  const add = (n: number, by: unknown) =>
    typeof by === "number" && Number.isFinite(by) ? Math.max(0, n + Math.trunc(by)) : n;
  return { asks: add(c.asks, d.asks), due: add(c.due, d.due) };
}

/** The part of `navigator` the Badging API adds (absent where unsupported). */
export type BadgeNav = {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Show `n` on the icon, or clear it at 0. False when the API is missing or
 * refused (iOS without notification permission, a browser tab): never thrown.
 */
export async function setBadge(nav: BadgeNav | null | undefined, n: number): Promise<boolean> {
  if (!nav || typeof nav.setAppBadge !== "function") return false;
  try {
    if (n > 0) await nav.setAppBadge(Math.min(Math.floor(n), BADGE_MAX));
    else if (typeof nav.clearAppBadge === "function") await nav.clearAppBadge();
    else await nav.setAppBadge(0);
    return true;
  } catch {
    return false;
  }
}

// ── The device's setting ────────────────────────────────────────────────

export function readBadgeMode(): BadgeMode {
  try {
    return parseBadgeMode(globalThis.localStorage?.getItem(BADGE_PREF_KEY));
  } catch {
    return BADGE_DEFAULT;
  }
}

/** The settings row: kept on the device and pushed to the account. */
export function writeBadgeMode(mode: BadgeMode) {
  try {
    globalThis.localStorage?.setItem(BADGE_PREF_KEY, mode);
  } catch {}
  notePrefWrite();
  try {
    globalThis.dispatchEvent?.(new Event(BADGE_MODE_EVENT));
  } catch {}
}

/** Something the badge counts was dealt with on this page (an ask answered, a card graded). */
export function noteBadgeSeen(delta: BadgeDelta) {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(BADGE_SEEN_EVENT, { detail: delta }));
  } catch {}
}

// ── The page's controller ───────────────────────────────────────────────

export type BadgeDeps = {
  /** navigator, or null where there is none. */
  nav: BadgeNav | null;
  /** The endpoint's counts for `mode`, or null (offline, signed out, flag off). */
  fetchCounts: (mode: BadgeMode) => Promise<BadgeCounts | null>;
  mode: () => BadgeMode;
  path: () => string | null;
  now: () => number;
  /** Tell the service worker the mode, for a push that carries counts only. */
  tellWorker?: (mode: BadgeMode) => void;
};

/**
 * One per tab (AppBadge.tsx). `refresh()` on open, on becoming visible and on a
 * pref change; `seen()` when something counted was dealt with; `render()` when
 * only the screen changed. Nothing polls.
 */
export function badgeController(deps: BadgeDeps) {
  let counts: BadgeCounts | null = null;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | null = null;

  const render = () => setBadge(deps.nav, badgeCount(deps.mode(), counts, seenOn(deps.path())));

  async function refresh(force = false): Promise<boolean> {
    const mode = deps.mode();
    deps.tellWorker?.(mode);
    if (mode === "off") return render();
    if (!deps.nav || typeof deps.nav.setAppBadge !== "function") return false;
    if (force || !counts || deps.now() - fetchedAt >= BADGE_MIN_FETCH_MS) {
      if (!pending) {
        fetchedAt = deps.now();
        pending = deps
          .fetchCounts(mode)
          .then((c) => {
            if (c) counts = c;
          })
          .catch(() => {})
          .finally(() => {
            pending = null;
          });
      }
      await pending;
    }
    return render();
  }

  function seen(d: BadgeDelta): Promise<boolean> {
    if (d.refresh) return refresh(true);
    if (counts) counts = applyDelta(counts, d);
    return render();
  }

  return { refresh, seen, render, counts: () => counts };
}
