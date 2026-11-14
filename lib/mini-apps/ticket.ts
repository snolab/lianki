/**
 * The signed ticket in a mini app's iframe URL (docs/mini-apps.md,
 * "Isolation"). The app's own origin never sees the session cookie (it is
 * `__Host-`, lianki.com only), so the host page, which has the session, signs
 * which file to serve: account, app, content hash, and where /m/ files are.
 * HMAC-SHA256 with AUTH_SECRET; short-lived; it grants reading that one file
 * and nothing else.
 */
export const TICKET_MS = 10 * 60_000;

export type Ticket = {
  /** Account id. */
  u: string;
  /** App id. */
  a: string;
  /** Slug. */
  s: string;
  /** The file's SHA-256 (first 16 hex): a republish needs a new ticket. */
  h: string;
  /** Lianki's origin for the /m/ files in the CSP. */
  b: string;
  /** Host page origin (frame-ancestors). */
  f: string;
  /** Expiry, epoch ms. */
  e: number;
};

const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const unb64u = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`mini-apps:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export const secretUsable = (s: string | undefined): s is string => !!s && s.length >= 32;

export async function signTicket(t: Ticket, secret: string): Promise<string> {
  const body = b64u(new TextEncoder().encode(JSON.stringify(t)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await key(secret), new TextEncoder().encode(body)),
  );
  return `${body}.${b64u(sig)}`;
}

/** The ticket's claims when its signature holds and it has not expired; else null. */
export async function verifyTicket(raw: unknown, secret: string, now = Date.now()) {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  const [body, sig, extra] = raw.split(".");
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      unb64u(sig),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;
    const t = JSON.parse(new TextDecoder().decode(unb64u(body))) as Ticket;
    if (typeof t?.e !== "number" || t.e <= now) return null;
    if (![t.u, t.a, t.s, t.h, t.b, t.f].every((x) => typeof x === "string")) return null;
    return t;
  } catch {
    return null;
  }
}
