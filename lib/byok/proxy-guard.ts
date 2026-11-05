// The guards of Lianki's BYOK relay (`POST /api/byok/proxy`, docs/byok.md
// "The relay"). Pure functions, no I/O except the injected DNS lookup, so
// every rule is unit-tested (unit/byok-proxy.test.ts).
//
// The relay is NOT an open proxy (owner, 2026-11-05 15:35 JST): it forwards
// only to the allowlist in lib/byok/presets.ts (`relay: {host, paths}`) —
// exact host, https, port 443, exact path, POST. A custom base URL is never
// relayed. The other rules below still apply to allowlisted hosts, as
// defence in depth: what a hostname resolves to must be public (a hijacked
// or misconfigured DNS record pointing at a private or metadata address is
// refused), redirects are re-checked hop by hop against the same allowlist.

import { MODEL_RE, presetOf, type ByokPreset } from "./presets";

// ── Limits ────────────────────────────────────────────────────────────────

export const PROXY_LIMITS = {
  /** The request body we accept from the browser. */
  maxBodyBytes: 64 * 1024,
  /** The provider's answer we pass back; more is cut off with an error. */
  maxResponseBytes: 1024 * 1024,
  /** One call, all hops and the body included. */
  timeoutMs: 30_000,
  /** Redirects followed (each re-checked). */
  maxHops: 3,
  maxMessages: 40,
  maxChars: 48_000,
  maxTokens: 4096,
  maxKeyLength: 512,
} as const;

const MIN = 60_000;
/** Per minute: per IP, per signed-in user, and for the whole relay. */
export const PROXY_RATE = {
  ip: { max: 40, windowMs: MIN },
  user: { max: 60, windowMs: MIN },
  global: { max: 1000, windowMs: MIN },
} as const;

// ── IP addresses ──────────────────────────────────────────────────────────

/** Dotted IPv4 to a 32-bit number; null unless exactly four 0–255 decimals. */
export function parseIpv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** IPv6 (with or without brackets, a dotted tail allowed) to 8 groups; null if malformed. */
export function parseIpv6(raw: string): number[] | null {
  let s = raw.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.includes("%")) return null; // zone ids: never
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIpv4(last);
    if (v4 === null) return null;
    tail = [v4 >>> 16, v4 & 0xffff];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const n = groups.map((g) => parseInt(g, 16));
  if (tail.length) n.splice(6, 2, ...tail);
  return n;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network", unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => {
    const b = parseIpv4(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (b & mask) >>> 0;
  });
}

function v6Blocked(g: number[]): boolean {
  const zeroTo = (k: number) => g.slice(0, k).every((x) => x === 0);
  // ::/128 unspecified, ::1 loopback, ::a.b.c.d IPv4-compatible (deprecated): all of ::/96.
  if (zeroTo(6)) return true;
  // ::ffff:a.b.c.d IPv4-mapped: judged as the IPv4 address — and refused anyway,
  // a public provider never answers with one.
  if (zeroTo(5) && g[5] === 0xffff) return true;
  // ::ffff:0:a.b.c.d (IPv4-translated).
  if (zeroTo(4) && g[4] === 0xffff && g[5] === 0) return true;
  // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64: embed an IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  // 100::/64 discard.
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  // 2001::/23 IETF special (Teredo 2001::/32, ORCHID, benchmarking…), 2001:db8::/32 docs.
  if (g[0] === 0x2001 && (g[1] < 0x200 || g[1] === 0xdb8)) return true;
  // 2002::/16 6to4: tunnels to an embedded IPv4 address; never a provider's.
  if (g[0] === 0x2002) return true;
  // fc00::/7 unique local (incl. AWS metadata fd00:ec2::254), fe80::/10 link-local,
  // fec0::/10 site-local, ff00::/8 multicast.
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  // Only global unicast 2000::/3 is left as possibly public.
  return (g[0] & 0xe000) !== 0x2000;
}

/**
 * An address the relay must never reach: private, loopback, link-local,
 * CGNAT, multicast, unspecified, documentation/reserved, cloud metadata, for
 * IPv4 and IPv6 (IPv4-mapped / -compatible / NAT64 / 6to4 / Teredo forms
 * included). Anything that does not parse as an address is blocked too.
 */
export function ipBlocked(ip: string): boolean {
  const v4 = parseIpv4(ip.trim());
  if (v4 !== null) return v4Blocked(v4);
  const v6 = parseIpv6(ip);
  if (v6) return v6Blocked(v6);
  return true;
}

/**
 * Is this hostname an IP address in any spelling? The WHATWG URL parser
 * already turns decimal/octal/hex IPv4 (`2130706433`, `0177.0.0.1`,
 * `0x7f.1`) into dotted form; this also catches what a raw string may hold.
 */
export function looksLikeIp(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.includes(":") || h.startsWith("[")) return true;
  // Every label numeric (decimal, 0-octal, 0x-hex): an IPv4 address in some form.
  return h.split(".").every((l) => /^(0x[0-9a-f]*|\d+)$/.test(l));
}

/** Names that are never public. */
const NEVER_HOSTS =
  /(^|\.)(lianki\.com|workers\.dev|localhost|local|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "metadata.azure.com",
]);

// ── The target ────────────────────────────────────────────────────────────

export type RefuseReason =
  | "provider" // not an allowlisted provider
  | "url" // does not parse, credentials, query, fragment, encoded path
  | "scheme" // not https / not port 443
  | "host" // not the provider's allowlisted host (or a never-host, an IP literal)
  | "path" // not one of the allowed paths
  | "dns" // the host did not resolve, or not to public addresses only
  | "redirect"; // a redirect we do not follow (cross-host, too many, 301/302/303)

export type TargetCheck =
  | { ok: true; url: string; preset: ByokPreset }
  | { ok: false; reason: RefuseReason };

/**
 * Check one URL the relay would POST to, for this provider: https on port
 * 443, no `user:pass@`, no query or fragment, no percent-encoding or dot
 * segments in the path, a hostname (never an IP literal, never one of ours,
 * never a local or metadata name) that is exactly the preset's allowlisted
 * host, and a path that is exactly one of its allowed paths.
 */
export function checkTarget(rawUrl: string, preset: ByokPreset | null): TargetCheck {
  if (!preset?.relay) return { ok: false, reason: "provider" };
  if (typeof rawUrl !== "string" || rawUrl.length > 300) return { ok: false, reason: "url" };
  // Percent-encoding and backslashes are never part of an allowlisted path.
  if (/[%\\\s@]/.test(rawUrl.replace(/^https:\/\//i, ""))) return { ok: false, reason: "url" };
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "url" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (u.port !== "" && u.port !== "443") return { ok: false, reason: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "url" };
  if (u.search || u.hash || rawUrl.includes("?") || rawUrl.includes("#"))
    return { ok: false, reason: "url" };
  const host = u.hostname.toLowerCase();
  if (
    looksLikeIp(host) ||
    NEVER_HOSTS.test(host) ||
    METADATA_HOSTS.has(host) ||
    !host.includes(".") ||
    host !== preset.relay.host
  )
    return { ok: false, reason: "host" };
  if (!preset.relay.paths.includes(u.pathname)) return { ok: false, reason: "path" };
  return { ok: true, url: `https://${host}${u.pathname}`, preset };
}

/** The endpoint for a backend's base URL, by protocol (what the browser would call). */
export function endpointOf(baseUrl: string, preset: ByokPreset): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return `${base}${preset.protocol === "anthropic" ? "/messages" : "/chat/completions"}`;
}

/** The provider + base URL the browser sent, as a relay target. */
export function checkBackend(provider: unknown, baseUrl: unknown): TargetCheck {
  const preset = typeof provider === "string" ? presetOf(provider) : null;
  if (!preset?.relay) return { ok: false, reason: "provider" };
  if (typeof baseUrl !== "string") return { ok: false, reason: "url" };
  return checkTarget(endpointOf(baseUrl, preset), preset);
}

/**
 * The next hop of a redirect, or why not. Only 307/308 (they keep POST and
 * the body; 301/302/303 would turn it into a GET), at most `maxHops`, to the
 * SAME allowlisted host and an allowed path — the key never goes to a host
 * the user did not pick. The new host is resolved and checked again.
 */
export function checkRedirect(
  status: number,
  location: string | null,
  current: string,
  preset: ByokPreset,
  hops: number,
): TargetCheck {
  if (status !== 307 && status !== 308) return { ok: false, reason: "redirect" };
  if (!location || hops >= PROXY_LIMITS.maxHops) return { ok: false, reason: "redirect" };
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return { ok: false, reason: "redirect" };
  }
  const t = checkTarget(next.href, preset);
  if (!t.ok) return t;
  if (new URL(t.url).host !== new URL(current).host) return { ok: false, reason: "redirect" };
  return t;
}

// ── DNS (DoH) ─────────────────────────────────────────────────────────────

export type Resolve = (host: string) => Promise<{ ok: true } | { ok: false }>;

type DohAnswer = { type?: number; data?: string };

/**
 * Resolve `host` over DNS-over-HTTPS (Cloudflare's resolver, A and AAAA) and
 * accept it only if it has at least one address and every address and CNAME
 * on the way is public and not ours. A Worker cannot pin the address it
 * fetches, so this narrows, not closes, a rebinding window (docs/byok.md,
 * "Residual risks"). Fails closed. Accepted hosts are remembered for 60 s
 * (host names only; nothing of the request).
 */
export function dohResolver(f: typeof fetch = fetch, ttlMs = 60_000): Resolve {
  const okUntil = new Map<string, number>();
  return async (host) => {
    const now = Date.now();
    if ((okUntil.get(host) ?? 0) > now) return { ok: true };
    try {
      const ask = async (type: "A" | "AAAA") => {
        // "manual", never "error": a Worker's fetch throws on "error". A 3xx is
        // not ok, so a redirected lookup is still refused below.
        const r = await f(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
          { headers: { accept: "application/dns-json" }, redirect: "manual" },
        );
        if (!r.ok) throw new Error("doh");
        const j = (await r.json()) as { Status?: number; Answer?: DohAnswer[] };
        if (j.Status !== 0 && j.Status !== 3) throw new Error("doh");
        return j.Answer ?? [];
      };
      const answers = [...(await ask("A")), ...(await ask("AAAA"))];
      if (!dnsAnswersOk(answers)) return { ok: false };
      okUntil.set(host, now + ttlMs);
      if (okUntil.size > 100) okUntil.delete(okUntil.keys().next().value!);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };
}

/** At least one address; every A/AAAA public; no CNAME into our own or a local name. */
export function dnsAnswersOk(answers: DohAnswer[]): boolean {
  let addresses = 0;
  for (const a of answers) {
    const data = String(a.data ?? "").trim();
    if (a.type === 1 || a.type === 28) {
      addresses++;
      if (ipBlocked(data)) return false;
    } else if (a.type === 5) {
      const name = data.toLowerCase().replace(/\.$/, "");
      if (NEVER_HOSTS.test(name) || METADATA_HOSTS.has(name) || looksLikeIp(name)) return false;
    }
  }
  return addresses > 0;
}

// ── The request body ──────────────────────────────────────────────────────

export interface ProxyInput {
  provider: string;
  baseUrl: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens: number;
  temperature: number;
}

const FIELDS = new Set(["provider", "baseUrl", "model", "messages", "maxTokens", "temperature"]);
const ROLES = new Set(["system", "user", "assistant"]);

/**
 * The browser's JSON, strictly: only these fields, a known model name, at
 * most 40 messages of plain text and 48 000 characters, maxTokens 1–4096,
 * temperature 0–2. No other provider parameter passes through.
 */
export function parseInput(v: unknown): ProxyInput | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  if (Object.keys(b).some((k) => !FIELDS.has(k))) return null;
  if (typeof b.provider !== "string" || typeof b.baseUrl !== "string") return null;
  if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return null;
  if (!Array.isArray(b.messages) || !b.messages.length) return null;
  if (b.messages.length > PROXY_LIMITS.maxMessages) return null;
  let chars = 0;
  const messages: ProxyInput["messages"] = [];
  for (const m of b.messages) {
    if (!m || typeof m !== "object") return null;
    const { role, content, ...rest } = m as Record<string, unknown>;
    if (Object.keys(rest).length) return null;
    if (typeof role !== "string" || !ROLES.has(role) || typeof content !== "string") return null;
    chars += content.length;
    messages.push({ role: role as ProxyInput["messages"][number]["role"], content });
  }
  if (chars > PROXY_LIMITS.maxChars) return null;
  const maxTokens = b.maxTokens;
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > PROXY_LIMITS.maxTokens
  )
    return null;
  const temperature = b.temperature === undefined ? 0.2 : b.temperature;
  if (typeof temperature !== "number" || !(temperature >= 0 && temperature <= 2)) return null;
  return {
    provider: b.provider,
    baseUrl: b.baseUrl,
    model: b.model,
    messages,
    maxTokens,
    temperature,
  };
}

/** The key from `Authorization: Bearer …`: printable ASCII, no spaces, bounded. */
export function keyOf(headers: Headers): string | null {
  const h = headers.get("authorization");
  const m = h ? /^Bearer ([\x21-\x7e]{1,512})$/.exec(h) : null;
  return m ? m[1] : null;
}
