/**
 * Links that leave Lianki (owner, 2026-11-09): before a person goes to
 * another site, the app shows a disclaimer — that site is not affiliated with
 * Lianki, and Lianki is not responsible for its content. Two ways past it,
 * both account settings (docs/prefs-sync.md):
 *
 * - `links.confirm` false: never ask, for any site;
 * - `links.trustedHosts`: sites the person said not to ask about again.
 *
 * Pure: no DOM, no storage. The app's delegated click handler
 * (app/components/ExternalLinkGuard.tsx) and the schema use it.
 */

/** Hosts that are Lianki: the apex and every subdomain. */
export const OWN_DOMAIN = "lianki.com";
/** Longest host the allowlist keeps. */
export const TRUSTED_HOST_MAX = 120;
/** Most hosts the allowlist keeps; the oldest go first. */
export const TRUSTED_HOSTS_MAX = 80;
/** The allowlist's JSON stays under the prefs' 2 KB value cap. */
export const TRUSTED_HOSTS_BYTES = 1900;

export type LinkTrust = {
  /** false: never ask (the account's "any site" box). */
  confirm: boolean;
  /** Sites never asked about, in stored form (trustedHostOf). */
  hosts: readonly string[];
};

export const DEFAULT_LINK_TRUST: LinkTrust = { confirm: true, hosts: [] };

/** lianki.com or one of its subdomains. */
export function isOwnHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === OWN_DOMAIN || h.endsWith(`.${OWN_DOMAIN}`);
}

/**
 * The host a link leaves for, or null when it does not leave: a relative link,
 * this page's own host, lianki.com and its subdomains, or a link that is not
 * http(s) (mailto:, tel:, javascript:, blob:… are not a site).
 */
export function leavingHost(href: string, base: string): string | null {
  let to: URL;
  let from: URL;
  try {
    from = new URL(base);
    to = new URL(href, from);
  } catch {
    return null;
  }
  if (to.protocol !== "http:" && to.protocol !== "https:") return null;
  if (!to.hostname) return null;
  if (to.host === from.host) return null;
  if (isOwnHost(to.hostname)) return null;
  return to.hostname.toLowerCase();
}

/**
 * The form a site is kept in the allowlist, or null when it cannot be kept: a
 * public host without its leading "www.". Device and tailnet hosts, bare
 * names, IP addresses and anything with a scheme or path never pass, so the
 * account's list can only ever name public sites.
 */
export function trustedHostOf(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const host = input.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!host || host.length > TRUSTED_HOST_MAX) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (/\.ts\.net$|\.local$|\.internal$|\.localhost$|\.\d+$/.test(host)) return null;
  return host;
}

/** Is this a value the allowlist may hold: already in stored form? */
export const isTrustedHost = (host: unknown): host is string =>
  typeof host === "string" && trustedHostOf(host) === host;

/** Is `host` on the list: the site itself, or a subdomain of one listed. */
export function hostIsTrusted(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return hosts.some((t) => h === t || h.endsWith(`.${t}`));
}

/** The host to ask about before following `href` from `base`, or null: go without asking. */
export function hostToConfirm(href: string, base: string, trust: LinkTrust): string | null {
  const host = leavingHost(href, base);
  if (!host || !trust.confirm || hostIsTrusted(host, trust.hosts)) return null;
  return host;
}

/**
 * The list with `host` added at the end (the newest), without duplicates;
 * the oldest drop off when it is over TRUSTED_HOSTS_MAX or its JSON over
 * TRUSTED_HOSTS_BYTES. A host that cannot be kept leaves the list as it is.
 */
export function addTrustedHost(hosts: readonly string[], host: string): string[] {
  const h = trustedHostOf(host);
  const list = hosts.filter(isTrustedHost);
  if (!h) return list;
  const next = [...list.filter((x) => x !== h), h];
  while (
    next.length > 1 &&
    (next.length > TRUSTED_HOSTS_MAX || JSON.stringify(next).length > TRUSTED_HOSTS_BYTES)
  )
    next.shift();
  return next;
}

/** A stored allowlist, cleaned: only hosts in stored form, no duplicates, within the caps. */
export function parseTrustedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  let out: string[] = [];
  for (const v of value) if (isTrustedHost(v)) out = addTrustedHost(out, v);
  return out;
}
