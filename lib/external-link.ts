/**
 * The disclaimer before leaving for another site, on the device
 * (@lianki/core/externalLink has the rules). Both bypasses are account
 * preferences (docs/prefs-sync.md): `links.confirm` in `lk:link-confirm`
 * ("1"/"0") and `links.allowedHosts` in `lk:link-allowed` (JSON). A writer
 * here calls notePrefWrite(), so the change follows the account.
 *
 * Links are caught by one delegated click handler (ExternalLinkGuard). Code
 * that opens a site itself (window.open) calls openExternal() instead.
 *
 * Neither bypass holds for good (lib/dont-ask.ts): each asks again after a
 * spaced interval, and is dropped when that question is answered without
 * the box.
 */
import { notePrefWrite } from "@lianki/ui-state/account";
import { chooseDontAsk, dontAskId, dontAskQuiet, forgetDontAsk } from "@/lib/dont-ask";
import {
  addAllowedHost,
  hostToConfirm,
  leavingHost,
  type LinkPolicy,
  parseAllowedHosts,
} from "@lianki/core/externalLink";

export const LINK_CONFIRM_KEY = "lk:link-confirm";
export const LINK_ALLOWED_KEY = "lk:link-allowed";
/** Fired on window after this tab changed a bypass (the settings section re-reads). */
export const LINK_POLICY_EVENT = "lk:link-policy";

const get = (k: string): string | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

const ANY = dontAskId("link-any");
const siteId = (host: string) => dontAskId("link-site", host);

/** The two settings as stored, before their re-ask dates. */
export function readStoredLinkPolicy(): LinkPolicy {
  let hosts: string[] = [];
  try {
    hosts = parseAllowedHosts(JSON.parse(get(LINK_ALLOWED_KEY) ?? "[]"));
  } catch {}
  return { confirm: get(LINK_CONFIRM_KEY) !== "0", hosts };
}

/**
 * What holds today: a bypass counts only until its re-ask date
 * (lib/dont-ask.ts); unreadable storage reads as "ask".
 */
export function readLinkPolicy(): LinkPolicy {
  const stored = readStoredLinkPolicy();
  return {
    confirm: stored.confirm || !dontAskQuiet(ANY),
    hosts: stored.hosts.filter((h) => dontAskQuiet(siteId(h))),
  };
}

function changed() {
  notePrefWrite();
  try {
    window.dispatchEvent(new Event(LINK_POLICY_EVENT));
  } catch {}
}

/** "Ask before opening other sites": false is the "any site" box. */
export function setLinkConfirm(on: boolean) {
  set(LINK_CONFIRM_KEY, on ? "1" : "0");
  if (on) forgetDontAsk(ANY);
  else chooseDontAsk(ANY);
  changed();
}

/** "Don't ask again for this site" (picked again after a re-ask: a longer wait). */
export function allowHost(host: string) {
  set(LINK_ALLOWED_KEY, JSON.stringify(addAllowedHost(readStoredLinkPolicy().hosts, host)));
  chooseDontAsk(siteId(host));
  changed();
}

/** Remove sites from the list (all of them when `hosts` is omitted). */
export function forgetAllowedHosts(hosts?: readonly string[]) {
  const stored = readStoredLinkPolicy().hosts;
  const gone = hosts ? stored.filter((h) => hosts.includes(h)) : stored;
  set(LINK_ALLOWED_KEY, JSON.stringify(stored.filter((h) => !gone.includes(h))));
  for (const h of gone) forgetDontAsk(siteId(h));
  changed();
}

/**
 * The dialog's answer, "Open site" with its two boxes. A bypass that came
 * back (its re-ask date passed) and was not ticked this time is dropped.
 */
export function answerLeave(
  host: string,
  { skipSite, skipAll }: { skipSite: boolean; skipAll: boolean },
) {
  const stored = readStoredLinkPolicy();
  if (skipAll) return setLinkConfirm(false);
  if (!stored.confirm) setLinkConfirm(true);
  if (skipSite) allowHost(host);
  else if (stored.hosts.includes(host)) forgetAllowedHosts([host]);
}

/** What the guard is asked to show: the site, the full link, and how to go there. */
export type LeaveRequest = { host: string; href: string; newTab: boolean };
type Presenter = (r: LeaveRequest) => void;

const PRESENTER = "__lkExternalLink";
const presenter = (): Presenter | undefined =>
  (globalThis as unknown as Record<string, Presenter | undefined>)[PRESENTER];

/** The mounted guard registers how it shows the disclaimer; returns the removal. */
export function setLeavePresenter(p: Presenter): () => void {
  const g = globalThis as unknown as Record<string, Presenter | undefined>;
  g[PRESENTER] = p;
  return () => {
    if (g[PRESENTER] === p) g[PRESENTER] = undefined;
  };
}

/**
 * Go to `href` without the opener and the referrer: a temporary link with
 * rel="noopener noreferrer", clicked (the guard lets links marked
 * data-lk-ext-ok through).
 */
export function followLink(href: string, newTab: boolean) {
  try {
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener noreferrer";
    if (newTab) a.target = "_blank";
    a.dataset.lkExtOk = "";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    if (newTab) window.open(href, "_blank", "noopener,noreferrer");
    else window.location.assign(href);
  }
}

/**
 * For code that opens a site itself (a search, a card's page): asks first when
 * the site needs it, else opens at once, in the same user gesture.
 */
export function openExternal(href: string, { newTab = true }: { newTab?: boolean } = {}) {
  const host = hostToConfirm(href, window.location.href, readLinkPolicy());
  const show = presenter();
  if (host && show) show({ host, href: new URL(href, window.location.href).href, newTab });
  else followLink(href, newTab);
}

type ElLike = {
  tagName?: string;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
  closest?(s: string): ElLike | null;
  setAttribute?(name: string, value: string): void;
};
export type LinkClick = {
  type?: string;
  target: unknown;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  composedPath?(): unknown[];
};
/** A click on a link that leaves Lianki: the link, where it goes, how, and the site to ask about. */
export type LeavingClick = {
  anchor: ElLike;
  href: string;
  newTab: boolean;
  /** The site to ask about; null: allowed, or asking is off — go without asking. */
  ask: string | null;
};

/** The link a click (or a middle-click's auxclick) follows, inside shadow roots too. */
function anchorOf(e: LinkClick): ElLike | null {
  const isLink = (n: unknown): n is ElLike => {
    const el = n as ElLike | null;
    const tag = el?.tagName?.toLowerCase();
    return (tag === "a" || tag === "area") && !!el?.hasAttribute?.("href");
  };
  for (const n of e.composedPath?.() ?? []) if (isLink(n)) return n;
  const t = e.target as ElLike | null;
  const a = t?.closest?.("a[href], area[href]") ?? null;
  return a && isLink(a) ? a : null;
}

/**
 * The click, when it follows a link to another site (else null: a link on
 * Lianki, a download, a link someone else already handled, or no link).
 */
export function leavingClick(e: LinkClick, here: string, policy: LinkPolicy): LeavingClick | null {
  if (e.defaultPrevented) return null;
  const middle = e.type === "auxclick";
  if (middle ? e.button !== 1 : (e.button ?? 0) !== 0) return null;
  const a = anchorOf(e);
  if (!a || a.hasAttribute?.("data-lk-ext-ok") || a.hasAttribute?.("download")) return null;
  const raw = a.getAttribute?.("href") ?? "";
  if (!leavingHost(raw, here)) return null;
  let href: string;
  try {
    href = new URL(raw, here).href;
  } catch {
    return null;
  }
  const target = a.getAttribute?.("target");
  const newTab =
    middle || !!e.metaKey || !!e.ctrlKey || !!e.shiftKey || (!!target && target !== "_self");
  return { anchor: a, href, newTab, ask: hostToConfirm(href, here, policy) };
}

/** rel="noopener noreferrer" on a link that leaves, keeping its other rel words. */
export function guardRel(a: ElLike) {
  const words = new Set((a.getAttribute?.("rel") ?? "").split(/\s+/).filter(Boolean));
  words.add("noopener");
  words.add("noreferrer");
  a.setAttribute?.("rel", [...words].join(" "));
}
