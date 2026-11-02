/**
 * Tickets for the owner's local STT server when it is reached over the public
 * Cloudflare tunnel (wss://stt.lianki.com, docs/local-stt.md "Off the
 * tailnet"). lianki.com signs a 60 s, single-use ticket with an Ed25519
 * private key (Worker secret STT_TICKET_KEY, a JWK); the Mac holds only the
 * public key and verifies it before the WebSocket upgrade
 * (scripts/local-stt/ticket.py, the deployed verifier). No shared secret.
 *
 * Wire form: `<payload>.<signature>`, both base64url without padding; the
 * signature covers the ASCII bytes of `<payload>`. Payload JSON:
 * `{aud:"lianki-stt", jti, iat, exp}` (seconds). It travels in
 * Sec-WebSocket-Protocol, so it is limited to base64url and ".".
 *
 * `verifySttTicket` here mirrors ticket.py rule for rule, for the tests and
 * for tools; the server never trusts anything but its own copy.
 */

export const STT_TICKET_AUD = "lianki-stt";
/** A ticket lives this long (seconds). */
export const STT_TICKET_TTL_S = 60;
/** The subprotocol the page offers beside the ticket, and the server selects. */
export const STT_SUBPROTOCOL = "lianki-stt";

/**
 * The same keys sign the Learning Partner's userscript tickets
 * (docs/dev-debug-widget.md, "On every site"): another audience, so an STT
 * ticket never opens a hub socket and a hub ticket never reaches the STT.
 */
export const PARTNER_TICKET_AUD = "lianki-partner";
/** The subprotocol a userscript's hub socket offers beside its ticket. */
export const PARTNER_SUBPROTOCOL = "lianki-partner";
/**
 * The userscript asks for a partner ticket with this header (value "1"). A
 * web page cannot send it cross-origin without a CORS preflight, which the
 * route never answers.
 */
export const PARTNER_TICKET_HEADER = "x-lianki-userscript";

export type SttTicketPayload = { aud: string; jti: string; iat: number; exp: number };

const ED = { name: "Ed25519" } as const;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The private key from STT_TICKET_KEY (a JWK: kty OKP, crv Ed25519, d, x). */
export async function importTicketKey(jwk: string): Promise<CryptoKey> {
  const k = JSON.parse(jwk) as JsonWebKey;
  if (k.kty !== "OKP" || k.crv !== "Ed25519" || !k.d)
    throw new Error("STT_TICKET_KEY is not an Ed25519 private JWK");
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: k.d, x: k.x }, ED, false, [
    "sign",
  ]);
}

/** A public key from its raw 32 bytes, base64url (the form the Mac keeps). */
export async function importTicketPublicKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64url(raw.trim()) as BufferSource, ED, false, [
    "verify",
  ]);
}

function randomJti(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function signSttTicket(
  key: CryptoKey,
  o: { now?: number; jti?: string; ttlS?: number; aud?: string } = {},
): Promise<{ ticket: string; exp: number }> {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = iat + (o.ttlS ?? STT_TICKET_TTL_S);
  const payload: SttTicketPayload = {
    aud: o.aud ?? STT_TICKET_AUD,
    jti: o.jti ?? randomJti(),
    iat,
    exp,
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign(ED, key, new TextEncoder().encode(body)));
  return { ticket: `${body}.${b64url(sig)}`, exp };
}

/** Seen jti → its exp, so a ticket is good once. */
export type JtiStore = Map<string, number>;

export type VerifyResult = { ok: true; payload: SttTicketPayload } | { ok: false; error: string };

/** Clock skew allowed between the Worker and the Mac (seconds). */
export const STT_TICKET_SKEW_S = 5;

export async function verifySttTicket(
  ticket: string,
  pub: CryptoKey,
  seen: JtiStore,
  now: number = Date.now(),
  aud: string = STT_TICKET_AUD,
): Promise<VerifyResult> {
  const t = Math.floor(now / 1000);
  for (const [j, e] of seen) if (e + STT_TICKET_SKEW_S < t) seen.delete(j);
  const parts = ticket.split(".");
  if (parts.length !== 2 || ticket.length > 512) return { ok: false, error: "malformed" };
  let sig: Uint8Array;
  let p: SttTicketPayload;
  try {
    sig = fromB64url(parts[1]);
    const okSig = await crypto.subtle.verify(
      ED,
      pub,
      sig as BufferSource,
      new TextEncoder().encode(parts[0]),
    );
    if (!okSig) return { ok: false, error: "bad signature" };
    p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (p.aud !== aud) return { ok: false, error: "wrong aud" };
  if (typeof p.exp !== "number" || typeof p.iat !== "number" || typeof p.jti !== "string" || !p.jti)
    return { ok: false, error: "malformed" };
  if (p.exp - p.iat > STT_TICKET_TTL_S || p.iat > t + STT_TICKET_SKEW_S)
    return { ok: false, error: "bad lifetime" };
  if (p.exp + STT_TICKET_SKEW_S < t) return { ok: false, error: "expired" };
  if (seen.has(p.jti)) return { ok: false, error: "replayed" };
  seen.set(p.jti, p.exp);
  return { ok: true, payload: p };
}
