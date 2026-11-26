import { uuidv4 } from "../packages/debug-chat/src/uuid";
/** Browser-local global consent. It is a UI policy, never authentication. */
import { LICHAT_SITES_KEY, parseSites, siteKey, type GmStore } from "./pill-chat-trust";

export const GLOBAL_CHAT_KEY = "lianki_lichat_global_v1";
export const MAX_CHAT_SITES = 128;
export type GlobalConsent = "unknown" | "all" | "off";
export type GlobalChatPolicy = {
  version: 1;
  consent: GlobalConsent;
  principal: string | null;
  /** Changes only for consent/account transitions, never collapse or site-list UI changes. */
  consentStamp: string;
  excluded: string[];
  collapsed: string[];
};
const principalOk = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const hosts = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .map((x) => (typeof x === "string" ? siteKey(x) : null))
            .filter((x): x is string => x !== null),
        ),
      ].slice(0, MAX_CHAT_SITES)
    : [];
const empty = (): GlobalChatPolicy => ({
  version: 1,
  consent: "unknown",
  principal: null,
  consentStamp: "",
  excluded: [],
  collapsed: [],
});
export function parseGlobalChat(raw: unknown): GlobalChatPolicy {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!v || typeof v !== "object" || Array.isArray(v) || v.version !== 1) return empty();
    const principal = principalOk(v.principal) ? v.principal : null;
    const consent =
      v.consent === "off" ? "off" : v.consent === "all" && principal ? "all" : "unknown";
    return {
      version: 1,
      consent,
      principal,
      consentStamp:
        typeof v.consentStamp === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v.consentStamp)
          ? v.consentStamp
          : "",
      excluded: hosts(v.excluded),
      collapsed: hosts(v.collapsed),
    };
  } catch {
    return empty();
  }
}
/** Excluding a website also excludes its subdomains, never lookalike suffixes. */
export function chatSiteExcluded(policy: GlobalChatPolicy, hostname: string): boolean {
  const host = siteKey(hostname);
  return !host || policy.excluded.some((x) => host === x || host.endsWith("." + x));
}
export function globalChatAllowed(
  policy: GlobalChatPolicy,
  hostname: string,
  principal: string,
): boolean {
  return (
    principalOk(principal) &&
    policy.principal === principal &&
    policy.consent === "all" &&
    !chatSiteExcluded(policy, hostname)
  );
}
export function globalChatStore(gm: GmStore) {
  const read = (): GlobalChatPolicy => {
    const policy = parseGlobalChat(gm.getValue(GLOBAL_CHAT_KEY));
    // Old per-site denials survive an explicit global opt-in. Old allows never become global consent.
    const denied = Object.entries(parseSites(gm.getValue(LICHAT_SITES_KEY, "{}")))
      .filter(([, v]) => v === "never")
      .map(([host]) => host);
    policy.excluded = [...new Set([...policy.excluded, ...denied])];
    return policy;
  };
  const write = (policy: GlobalChatPolicy) =>
    gm.setValue(
      GLOBAL_CHAT_KEY,
      JSON.stringify({ ...policy, excluded: policy.excluded.slice(0, MAX_CHAT_SITES) }),
    );
  return {
    read,
    revoke() {
      write({ ...read(), consent: "off", consentStamp: uuidv4() });
    },
    invalidate() {
      const p = read();
      write({
        ...p,
        principal: null,
        consentStamp: uuidv4(),
        consent: p.consent === "off" ? "off" : "unknown",
        collapsed: [],
      });
    },
    consent(value: "all" | "off", principal: string): boolean {
      if (!principalOk(principal)) return false;
      write({ ...read(), principal, consent: value, consentStamp: uuidv4() });
      return true;
    },
    bind(principal: string): boolean {
      if (!principalOk(principal)) return false;
      const p = read();
      if (p.principal === principal) return true;
      // Another account never inherits a grant. An explicit browser-wide refusal stays off.
      write({
        ...p,
        principal,
        consentStamp: uuidv4(),
        consent: p.consent === "off" ? "off" : "unknown",
        collapsed: [],
      });
      return true;
    },
    exclude(hostname: string, excluded: boolean): boolean {
      const host = siteKey(hostname);
      if (!host) return false;
      const p = read();
      if (excluded && !p.excluded.includes(host) && p.excluded.length >= MAX_CHAT_SITES)
        return false;
      if (!excluded) {
        const legacy = parseSites(gm.getValue(LICHAT_SITES_KEY, "{}"));
        if (legacy[host] === "never") {
          delete legacy[host];
          gm.setValue(LICHAT_SITES_KEY, JSON.stringify(legacy));
        }
      }
      write({
        ...p,
        excluded: excluded ? hosts([...p.excluded, host]) : p.excluded.filter((x) => x !== host),
      });
      return true;
    },
    collapse(hostname: string, collapsed: boolean): boolean {
      const host = siteKey(hostname);
      if (!host) return false;
      const p = read();
      const rest = p.collapsed.filter((x) => x !== host);
      write({ ...p, collapsed: collapsed ? [...rest.slice(-(MAX_CHAT_SITES - 1)), host] : rest });
      return true;
    },
  };
}
