/**
 * Li chat from the userscript pill: the per-site trust gate's rules
 * (docs/userscript-li-chat.md, "Security gate"). Pure: no DOM, no network.
 * Tested in unit/pill-chat.test.ts.
 *
 * - The decision is per **exact hostname of the top window** and lives in the
 *   userscript's own GM storage (`lianki_lichat_sites`), never in the page's
 *   storage, a cookie or the DOM.
 * - Default deny: no stored decision means ask; a dismissed prompt is a deny
 *   and stores nothing. Nothing reaches lianki.com for chat before "allow".
 * - "Allow once" is memory only: this page load, this host.
 * - "Never" hides the pill's Li entry on that site, until he forgets it in
 *   the sites list.
 */

/** GM key of the per-site decisions: `{ [hostname]: "allow" | "never" }`. */
export const LICHAT_SITES_KEY = "lianki_lichat_sites";
/** GM key of the flag, as lianki.com last said it for this account: `{ on, at }`. */
export const PILLCHAT_ON_KEY = "lianki_pillchat_on";
/** The flag is asked again on lianki.com at most this often (ms). */
export const PILLCHAT_RECHECK_MS = 60_000;

export type SiteDecision = "allow" | "never";
export type TrustChoice = "once" | "always" | "never" | "dismiss";
export type Sites = Record<string, SiteDecision>;

/** A hostname as the store keys it: lowercase letters, digits, dots, dashes; at most 253. */
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
export const validHost = (h: unknown): h is string =>
  typeof h === "string" && h.length > 0 && h.length <= 253 && HOST_RE.test(h);

/** The store key for a page: its top window's exact hostname, lowercase (no port, no www folding). */
export const siteKey = (hostname: string): string | null => {
  const h = String(hostname ?? "").toLowerCase();
  return validHost(h) ? h : null;
};

/** What is stored, checked: unknown hosts or values are dropped, never trusted. */
export function parseSites(raw: unknown): Sites {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const out: Sites = Object.create(null);
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [h, d] of Object.entries(v as Record<string, unknown>)) {
    if (validHost(h) && (d === "allow" || d === "never")) out[h] = d;
  }
  return out;
}

export type GmStore = {
  getValue: (k: string, d?: any) => any;
  setValue: (k: string, v: any) => void;
};

/** The decisions, read fresh from GM storage on every call (another tab may have changed them). */
export function trustStore(gm: GmStore) {
  const read = () => parseSites(gm.getValue(LICHAT_SITES_KEY, "{}"));
  const write = (s: Sites) => gm.setValue(LICHAT_SITES_KEY, JSON.stringify(s));
  return {
    decision(host: string): SiteDecision | null {
      const k = siteKey(host);
      return k ? (read()[k] ?? null) : null;
    },
    set(host: string, d: SiteDecision) {
      const k = siteKey(host);
      if (!k) return;
      write({ ...read(), [k]: d });
    },
    forget(host: string) {
      const s = { ...read() };
      const k = siteKey(host);
      if (!k || !(k in s)) return;
      delete s[k];
      write(s);
    },
    list(): [string, SiteDecision][] {
      return Object.entries(read()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
  };
}
export type TrustStore = ReturnType<typeof trustStore>;

/**
 * The prompt's answer, applied. Returns whether chat may open now.
 * once → this page load only; always → stored allow; never → stored never;
 * dismiss (×, Escape, a click outside) → deny, nothing stored.
 */
export function applyChoice(
  store: TrustStore,
  onceHosts: Set<string>,
  host: string,
  choice: TrustChoice,
): boolean {
  const k = siteKey(host);
  if (!k) return false;
  if (choice === "once") {
    onceHosts.add(k);
    return true;
  }
  if (choice === "always") {
    store.set(k, "allow");
    return true;
  }
  if (choice === "never") store.set(k, "never");
  return false;
}

/** Is chat allowed on this host right now (stored allow, or allowed once on this page load)? */
export function allowedHere(store: TrustStore, onceHosts: Set<string>, host: string): boolean {
  const k = siteKey(host);
  if (!k) return false;
  const d = store.decision(k);
  if (d === "never") return false;
  return d === "allow" || onceHosts.has(k);
}

/** Is the flag on for this account, as lianki.com last said? Anything else is off. */
export function flagMirrorOn(raw: unknown): boolean {
  const v = typeof raw === "string" ? safeJson(raw) : raw;
  return !!v && typeof v === "object" && (v as { on?: unknown }).on === true;
}

/** Should lianki.com be asked for the flag again (on a lianki.com page load)? */
export function flagRecheckDue(raw: unknown, now: number): boolean {
  const v = typeof raw === "string" ? safeJson(raw) : raw;
  const at = v && typeof v === "object" ? (v as { at?: unknown }).at : undefined;
  return (
    typeof at !== "number" || !Number.isFinite(at) || now - at >= PILLCHAT_RECHECK_MS || at > now
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * What the pill shows for Li on this page:
 * - hidden: flag off for this account, not the top window, or "never" here;
 * - note: the manager runs us in the page's own realm, where the site could
 *   read anything we hold: the entry only explains, nothing is fetched;
 * - show: the Li entry; a tap asks first unless allowed.
 */
export function pillEntry(o: {
  flagOn: boolean;
  top: boolean;
  isolated: boolean;
  decision: SiteDecision | null;
  host: string | null;
}): "hidden" | "note" | "show" {
  if (!o.flagOn || !o.top || !o.host || o.decision === "never") return "hidden";
  return o.isolated ? "show" : "note";
}
