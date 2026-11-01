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
export const CHALLENGE_TTL_S = 120;
export type VoiceprintOp = "status" | "enrol" | "delete";
export const VOICEPRINT_OPS: readonly VoiceprintOp[] = ["status", "enrol", "delete"];

/** A device slug as the Mac's store takes it, or "*" (delete only: every device). */
export function validDevice(d: unknown, op: VoiceprintOp): d is string {
  if (typeof d !== "string") return false;
  if (d === "*") return op === "delete" || op === "status";
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
  o: { op: VoiceprintOp; device: string; uv: boolean; jti?: string; now?: number },
): Promise<{ ticket: string; exp: number }> {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = iat + VOICEPRINT_TICKET_TTL_S;
  const ticket = await signPayload(key, {
    aud: VOICEPRINT_AUD,
    op: o.op,
    device: o.device,
    uv: o.uv,
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
  exp: number;
};

export async function signChallenge(
  key: CryptoKey,
  o: { op: VoiceprintOp; device: string; uid: string; now?: number },
): Promise<{ token: string; challenge: string }> {
  const challenge = randomId(32);
  const exp = Math.floor((o.now ?? Date.now()) / 1000) + CHALLENGE_TTL_S;
  const p: Challenge = {
    aud: CHALLENGE_AUD,
    challenge,
    op: o.op,
    device: o.device,
    uid: o.uid,
    exp,
  };
  return { token: await signPayload(key, p), challenge };
}

/** The challenge token, if it is ours, live, and for this op, device and user. */
export async function openChallenge(
  token: string,
  pub: CryptoKey,
  want: { op: VoiceprintOp; device: string; uid: string; now?: number },
): Promise<Challenge | null> {
  const p = await openPayload(token, pub);
  if (!p || p.aud !== CHALLENGE_AUD) return null;
  if (p.op !== want.op || p.device !== want.device || p.uid !== want.uid) return null;
  if (typeof p.exp !== "number" || p.exp < Math.floor((want.now ?? Date.now()) / 1000)) return null;
  if (typeof p.challenge !== "string" || p.challenge.length < 32) return null;
  return p as unknown as Challenge;
}
