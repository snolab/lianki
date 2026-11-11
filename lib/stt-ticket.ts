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
 * The same keys sign the chat tickets of an owner's box (docs/box-oauth.md,
 * "Chat on the owner's box"): a third audience, and each one names the box's
 * exact origin (`org`) and client (`cid`). lianki-push takes it only from that
 * origin, under the partner subprotocol.
 */
export const BOX_CHAT_TICKET_AUD = "lianki-box-chat";
/**
 * The userscript asks for a partner ticket with this header (value "1"). A
 * web page cannot send it cross-origin without a CORS preflight, which the
 * route never answers.
 */
export const PARTNER_TICKET_HEADER = "x-lianki-userscript";

export type SttTicketPayload = {
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  /** A box chat ticket only: the box's exact origin and its client id. */
  org?: string;
  cid?: string;
};

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
  o: {
    now?: number;
    jti?: string;
    ttlS?: number;
    aud?: string;
    /** A box chat ticket's origin and client (BOX_CHAT_TICKET_AUD). */
    org?: string;
    cid?: string;
  } = {},
): Promise<{ ticket: string; exp: number }> {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = iat + (o.ttlS ?? STT_TICKET_TTL_S);
  const payload: SttTicketPayload = {
    aud: o.aud ?? STT_TICKET_AUD,
    jti: o.jti ?? randomJti(),
    iat,
    exp,
    ...(o.org ? { org: o.org } : {}),
    ...(o.cid ? { cid: o.cid } : {}),
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

/*
 * Ticket v2: Lianki's speech servers for other accounts (docs/local-stt.md,
 * "Lianki's speech servers for everyone"). Another audience, so a v2 ticket
 * never opens the owner's tunnel listener (which takes `lianki-stt` only) and a
 * v1 ticket never opens a public session. It names the account (`sub`), what it
 * may do (`scope`) and the limits the speech server enforces (`lim`), all signed:
 * the server never takes a limit from the page.
 *
 * Payload: `{aud:"lianki-stt2", v:2, jti, iat, exp, sub, scope:"stt", lim:{utt, sess}}`
 * — `utt` the longest utterance kept (s), `sess` the longest session (s).
 * The same key (STT_TICKET_KEY) and wire form as v1; 60 s, single use.
 * Verified by scripts/local-stt/ticket.py (`Tickets(..., aud=V2_AUD)` with
 * `check_payload`) and by the SttRegistry in lianki-push before signalling.
 */
export const STT_TICKET_V2_AUD = "lianki-stt2";
/** The only scope a v2 ticket carries for now: stream audio, get text back. */
export const STT_SCOPE = "stt";

export type SttLimits = {
  /** The longest utterance the server keeps (seconds). */
  utt: number;
  /** The longest session, from the socket's open (seconds). */
  sess: number;
};

export type SttTicketV2Payload = {
  aud: typeof STT_TICKET_V2_AUD;
  v: 2;
  jti: string;
  iat: number;
  exp: number;
  /** The account id the session is booked to (never an email). */
  sub: string;
  scope: typeof STT_SCOPE;
  lim: SttLimits;
};

/** An account id as it may travel in a ticket: what D1 `user.id` holds, nothing longer. */
const SUB_RE = /^[A-Za-z0-9_-]{1,64}$/;

const validLimits = (l: unknown): l is SttLimits => {
  const o = l as Partial<SttLimits> | null;
  return (
    !!o &&
    typeof o === "object" &&
    Number.isInteger(o.utt) &&
    Number.isInteger(o.sess) &&
    (o.utt as number) > 0 &&
    (o.utt as number) <= 120 &&
    (o.sess as number) > 0 &&
    (o.sess as number) <= 3600
  );
};

export async function signSttTicketV2(
  key: CryptoKey,
  o: { sub: string; lim: SttLimits; now?: number; jti?: string },
): Promise<{ ticket: string; exp: number; payload: SttTicketV2Payload }> {
  if (!SUB_RE.test(o.sub)) throw new Error("stt ticket: bad sub");
  if (!validLimits(o.lim)) throw new Error("stt ticket: bad limits");
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const payload: SttTicketV2Payload = {
    aud: STT_TICKET_V2_AUD,
    v: 2,
    jti: o.jti ?? randomJti(),
    iat,
    exp: iat + STT_TICKET_TTL_S,
    sub: o.sub,
    scope: STT_SCOPE,
    lim: { utt: o.lim.utt, sess: o.lim.sess },
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign(ED, key, new TextEncoder().encode(body)));
  return { ticket: `${body}.${b64url(sig)}`, exp: payload.exp, payload };
}

export type VerifyV2Result =
  | { ok: true; payload: SttTicketV2Payload }
  | { ok: false; error: string };

/**
 * A v2 ticket: everything v1 checks (signature, lifetime, once), then the v2
 * claims. Mirrors ticket.py `check_payload` with `V2_AUD`, rule for rule.
 */
export async function verifySttTicketV2(
  ticket: string,
  pub: CryptoKey,
  seen: JtiStore,
  now: number = Date.now(),
): Promise<VerifyV2Result> {
  // Claims first on a copy of the store, so a ticket with bad claims spends nothing.
  const probe: JtiStore = new Map(seen);
  const r = await verifySttTicket(ticket, pub, probe, now, STT_TICKET_V2_AUD);
  if (!r.ok) return r;
  const p = r.payload as unknown as Partial<SttTicketV2Payload>;
  if (p.v !== 2) return { ok: false, error: "wrong version" };
  if (typeof p.sub !== "string" || !SUB_RE.test(p.sub)) return { ok: false, error: "bad sub" };
  if (p.scope !== STT_SCOPE) return { ok: false, error: "wrong scope" };
  if (!validLimits(p.lim)) return { ok: false, error: "bad limits" };
  seen.clear();
  for (const [k, v] of probe) seen.set(k, v);
  return { ok: true, payload: p as SttTicketV2Payload };
}
