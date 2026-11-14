/**
 * Voiceprint tickets (docs/local-stt.md, "Voiceprint: who may enrol and
 * delete"). The owner's local STT server accepts a voiceprint op only with a
 * ticket for exactly that op (and device), signed by lianki.com with the same
 * Ed25519 key as the STT tickets (STT_TICKET_KEY; lib/stt-ticket.ts) under
 * another audience, so neither kind opens the other's door. The Mac checks it
 * with its copy of the public key (scripts/local-stt/ticket.py, aud
 * "lianki-voiceprint"), once.
 *
 * - `status`: a read-only owner ticket, for an owner session alone;
 * - `enrol` and `delete`: only after a fresh WebAuthn assertion with user
 *   verification (Face ID / Touch ID) from one of the owner's passkeys
 *   (app/api/dev/voiceprint-ticket; `uv: true` in the ticket). Page code,
 *   eval included, cannot make one without the owner at the device.
 *
 * The passkey challenge travels as a signed token (aud
 * "lianki-voiceprint-challenge", 120 s) so the Worker keeps no state; the
 * ticket's jti is that challenge, so the Mac's single-use jti store also stops
 * a second ticket minted from a replayed assertion.
 */
import { b64url, fromB64url } from "@/lib/stt-ticket";

export const VOICEPRINT_AUD = "lianki-voiceprint";
export const CHALLENGE_AUD = "lianki-voiceprint-challenge";
export const VOICEPRINT_TICKET_TTL_S = 60;
/**
 * The challenge and the ticket share one lifetime, fixed when the options are
 * issued: the ticket's iat/exp are the challenge's, never reminted at verify.
 */
export const CHALLENGE_TTL_S = VOICEPRINT_TICKET_TTL_S;
/**
 * `export`: the Mac hands the page the voice features (never audio), and the
 * same ticket lets lianki.com keep them in the account (app/api/my/voiceprint,
 * lib/voiceprint-cloud.ts). `restore`: the Mac takes a print the page read
 * from the account. Both need the passkey, as enrol and delete do.
 */
export type VoiceprintOp =
  | "status"
  | "enrol"
  | "delete"
  | "delete-audio"
  | "export"
  | "restore"
  | "progressive"
  | "clone-ref-put"
  | "clone-ref-delete";
export const VOICEPRINT_OPS: readonly VoiceprintOp[] = [
  "status",
  "enrol",
  "delete",
  "delete-audio",
  "export",
  "restore",
  "progressive",
  "clone-ref-put",
  "clone-ref-delete",
];
/**
 * The ops that need the owner's passkey with user verification (Face ID / Touch ID).
 * `delete-audio`: the enrolment recordings kept on the Mac, a separate question
 * from deleting the print (owner, 2026-11-11), with its own ticket.
 * `progressive`: learning from his own clean finals on or off (device "*";
 * docs/local-stt.md, "Progressive voiceprint"): it keeps features of what he
 * says without a sentence to read, so it is approved like an enrolment.
 */
export const PASSKEY_OPS: readonly VoiceprintOp[] = [
  "enrol",
  "delete",
  "delete-audio",
  "export",
  "restore",
  "progressive",
  "clone-ref-put",
  "clone-ref-delete",
];
/**
 * The voice-clone reference (lib/voice-clone-ref.ts, docs/voice-clone.md):
 * audio of his voice, kept in his account. Storing/replacing and deleting it
 * each take a fresh passkey assertion: the passkey window's grant never mints
 * them, and their assertion hands out no grant. The ticket is for the whole
 * account (device "*"), never one device.
 */
export const CLONE_REF_OPS: readonly VoiceprintOp[] = ["clone-ref-put", "clone-ref-delete"];
/** Ops the passkey window does not cover: a Face ID / Touch ID prompt every time. */
export const FRESH_PASSKEY_OPS: readonly VoiceprintOp[] = CLONE_REF_OPS;

/** A device slug as the Mac's store takes it, or "*" (every device: never for enrol). */
export function validDevice(d: unknown, op: VoiceprintOp): d is string {
  if (typeof d !== "string") return false;
  if (CLONE_REF_OPS.includes(op)) return d === "*";
  if (d === "*") return op !== "enrol";
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(d);
}

const ED = { name: "Ed25519" } as const;
const enc = new TextEncoder();

/** Sign any payload in the ticket wire form `<payload>.<signature>` (both base64url). */
export async function signPayload(key: CryptoKey, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign(ED, key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The payload if the signature verifies, else null (no field checks). */
export async function openPayload(
  token: string,
  pub: CryptoKey,
): Promise<Record<string, unknown> | null> {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || token.length > 2048) return null;
  try {
    const ok = await crypto.subtle.verify(
      ED,
      pub,
      fromB64url(parts[1]!) as BufferSource,
      enc.encode(parts[0]!),
    );
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]!)));
    return p && typeof p === "object" && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

/** The verify half of STT_TICKET_KEY (its JWK carries x). */
export async function importTicketVerifyKey(jwk: string): Promise<CryptoKey> {
  const k = JSON.parse(jwk) as JsonWebKey;
  if (k.kty !== "OKP" || k.crv !== "Ed25519" || !k.x) throw new Error("not an Ed25519 JWK");
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, ED, false, [
    "verify",
  ]);
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The ticket the Mac checks: op, device, and whether a passkey with UV stood behind it. */
export async function signVoiceprintTicket(
  key: CryptoKey,
  o: {
    op: VoiceprintOp;
    device: string;
    uv: boolean;
    keepAudio?: boolean;
    /** The account it was approved for: lianki.com checks it (lib/voiceprint-cloud.ts); the Mac ignores it. */
    uid?: string;
    jti?: string;
    now?: number;
    /** Fixed lifetime (the challenge's), when there is one. */
    iat?: number;
    exp?: number;
  },
): Promise<{ ticket: string; exp: number }> {
  const iat = o.iat ?? Math.floor((o.now ?? Date.now()) / 1000);
  const exp = o.exp ?? iat + VOICEPRINT_TICKET_TTL_S;
  const ticket = await signPayload(key, {
    aud: VOICEPRINT_AUD,
    op: o.op,
    device: o.device,
    uv: o.uv,
    ...(o.op === "enrol" ? { keepAudio: o.keepAudio === true } : {}),
    ...(o.uid ? { uid: o.uid } : {}),
    jti: o.jti ?? randomId(),
    iat,
    exp,
  });
  return { ticket, exp };
}

export type Challenge = {
  aud: typeof CHALLENGE_AUD;
  challenge: string;
  op: VoiceprintOp;
  device: string;
  uid: string;
  /** Enrol: whether the enrolment audio may be kept, as the owner approved it. */
  keepAudio: boolean;
  iat: number;
  exp: number;
};

export async function signChallenge(
  key: CryptoKey,
  o: { op: VoiceprintOp; device: string; uid: string; keepAudio?: boolean; now?: number },
): Promise<{ token: string; challenge: string }> {
  const challenge = randomId(32);
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const p: Challenge = {
    aud: CHALLENGE_AUD,
    challenge,
    op: o.op,
    device: o.device,
    uid: o.uid,
    keepAudio: o.keepAudio === true,
    iat,
    exp: iat + CHALLENGE_TTL_S,
  };
  return { token: await signPayload(key, p), challenge };
}

/** The challenge token, if it is ours, live, and for this op, device and user. */
export async function openChallenge(
  token: string,
  pub: CryptoKey,
  want: { op: VoiceprintOp; device: string; uid: string; keepAudio?: boolean; now?: number },
): Promise<Challenge | null> {
  const p = await openPayload(token, pub);
  if (!p || p.aud !== CHALLENGE_AUD) return null;
  if (p.op !== want.op || p.device !== want.device || p.uid !== want.uid) return null;
  if (p.keepAudio !== (want.keepAudio === true) || typeof p.iat !== "number") return null;
  if (typeof p.exp !== "number" || p.exp < Math.floor((want.now ?? Date.now()) / 1000)) return null;
  if (typeof p.challenge !== "string" || p.challenge.length < 32) return null;
  return p as unknown as Challenge;
}

// ---------------------------------------------------------------- the passkey window
/**
 * One passkey approval for every voiceprint op, for a while (owner, tap card
 * 2026-11-11 01:28 JST; docs/local-stt.md, "One approval for ten minutes").
 * After a verified assertion with UV, lianki.com also hands the page a
 * **grant**: a token for this account, this sign-in session and this device,
 * live until `exp` (config `voiceprint.passkeyWindowMs`). With it the page asks
 * for per-op tickets with no new prompt; each ticket is still single use (its
 * own jti), live 60 s at most and never past the grant, and the Mac's checks
 * (aud, op, device, uv, once) are exactly as before. Its own audience, so no
 * ticket, challenge or other step-up ever accepts it, and it opens nothing but
 * this route.
 */
export const GRANT_AUD = "lianki-voiceprint-grant";

export type Grant = {
  aud: typeof GRANT_AUD;
  /** The account (session user id). */
  uid: string;
  /** The sign-in session, hashed (sessionTag): a sign-out ends the grant here too. */
  sid: string;
  /** The page's device slug (deviceSlug in voiceprint.ts): the grant is for that device only. */
  client: string;
  /** The approval behind it (its challenge). */
  gid: string;
  iat: number;
  exp: number;
};

/** A session id as the grant carries it: SHA-256, 16 bytes, base64url (never the id itself). */
export async function sessionTag(sessionId: string): Promise<string> {
  const h = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(`vp-grant:${sessionId}`)),
  );
  return b64url(h.slice(0, 16));
}

export async function signGrant(
  key: CryptoKey,
  o: { uid: string; sid: string; client: string; gid: string; windowMs: number; now?: number },
): Promise<{ grant: string; exp: number }> {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = iat + Math.floor(o.windowMs / 1000);
  const p: Grant = {
    aud: GRANT_AUD,
    uid: o.uid,
    sid: o.sid,
    client: o.client,
    gid: o.gid,
    iat,
    exp,
  };
  return { grant: await signPayload(key, p), exp };
}

/**
 * The grant, if it is ours, for this account, session and device, and live:
 * under its own exp and under the window as configured now (a shorter window
 * set at /dev/config shortens grants already out; 0 ends them all).
 */
export async function openGrant(
  token: string,
  pub: CryptoKey,
  want: { uid: string; sid: string; client: string; windowMs: number; now?: number },
): Promise<Grant | null> {
  if (!(want.windowMs > 0) || !want.sid) return null;
  const p = await openPayload(token, pub);
  if (!p || p.aud !== GRANT_AUD) return null;
  if (p.uid !== want.uid || p.sid !== want.sid || p.client !== want.client) return null;
  if (typeof p.iat !== "number" || typeof p.exp !== "number" || typeof p.gid !== "string")
    return null;
  const now = Math.floor((want.now ?? Date.now()) / 1000);
  if (p.iat > now + 5 || p.exp <= now) return null;
  if (p.iat + Math.floor(want.windowMs / 1000) <= now) return null;
  return p as unknown as Grant;
}
