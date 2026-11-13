/**
 * The owner's passkey approval for a voiceprint op (docs/local-stt.md,
 * "Voiceprint: who may enrol and delete"), without the request plumbing so it
 * is unit-tested: app/api/dev/voiceprint-ticket is the route.
 *
 *   POST {op:"status"}                                   → {ticket}  (owner session only)
 *   POST {op:"enrol"|"delete", device, step:"options"}   → {options, token}
 *   POST {op, device, step:"verify", token, response, client}
 *                                                        → {ticket[, grant, grantExp]}  (after Face ID / Touch ID)
 *   POST {op, device, step:"grant", grant, client}       → {ticket, grantExp}  (no prompt: inside the window)
 *
 * `options` are WebAuthn request options (JSON form) for the owner's own
 * passkeys with userVerification "required"; `token` carries the challenge,
 * signed (lib/voiceprint-ticket.ts). The assertion must verify against one of
 * the owner's passkeys with the UV flag set; then the Mac gets a 60 s ticket
 * for that op and device whose jti is the challenge (single use there).
 *
 * The passkey window (docs/local-stt.md, "One approval for ten minutes"):
 * with `windowMs` > 0, the verify also returns a grant for this account,
 * session and `client` device; step "grant" turns it into one more ticket for
 * any passkey op, single use (a fresh jti), 60 s and never past the grant.
 */
import {
  FRESH_PASSKEY_OPS,
  PASSKEY_OPS,
  type VoiceprintOp,
  VOICEPRINT_TICKET_TTL_S,
  openChallenge,
  openGrant,
  randomId,
  signChallenge,
  signGrant,
  signVoiceprintTicket,
  validDevice,
} from "@/lib/voiceprint-ticket";

export type StoredPasskey = {
  id: string;
  credentialID: string;
  publicKey: string;
  counter: number;
  transports?: string | null;
};

export type AssertionCheck = (a: {
  response: unknown;
  expectedChallenge: string;
  expectedOrigin: string[];
  expectedRPID: string;
  credential: { id: string; publicKey: string; counter: number; transports?: string[] };
}) => Promise<{ verified: boolean; userVerified: boolean; newCounter: number }>;

export type ApprovalDeps = {
  key: CryptoKey;
  pub: CryptoKey;
  userId: string;
  passkeys: () => Promise<StoredPasskey[]>;
  check: AssertionCheck;
  saveCounter: (id: string, counter: number) => Promise<void>;
  /**
   * Spend this challenge for good (atomic: D1, a primary-key insert): true the
   * first time, false ever after. A replayed assertion (a synced passkey's
   * counter stays 0) can therefore never mint a second ticket.
   */
  consume: (challenge: string, exp: number) => Promise<boolean>;
  rp: { rpID: string; origins: string[] };
  /**
   * The passkey window (config `voiceprint.passkeyWindowMs`): after a verified
   * assertion, a grant this long lets the page mint per-op tickets with no new
   * prompt. 0 or absent: every op asks for the passkey, as before.
   */
  windowMs?: number;
  /** The sign-in session, hashed (sessionTag): the grant is bound to it. Absent: no grant. */
  sid?: string;
  now?: number;
};

type Out = { status: number; json: Record<string, unknown> };
const bad = (status: number, error: string): Out => ({ status, json: { error } });

export async function voiceprintApproval(body: unknown, d: ApprovalDeps): Promise<Out> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const op = b.op as VoiceprintOp;
  if (op === "status") {
    // Read-only: what is enrolled. An owner session is enough.
    const { ticket, exp } = await signVoiceprintTicket(d.key, {
      op,
      device: "*",
      uv: false,
      now: d.now,
    });
    return { status: 200, json: { ticket, exp } };
  }
  if (!PASSKEY_OPS.includes(op)) return bad(400, "bad op");
  const device = b.device;
  if (!validDevice(device, op)) return bad(400, "bad device");
  // Enrol: keeping the audio is part of what he approves with the passkey.
  const keepAudio = op === "enrol" && b.keepAudio === true;
  const keys = await d.passkeys();
  if (!keys.length) return bad(409, "no passkey: add one on the profile page first");
  if (b.step === "grant") {
    // The voice-clone reference: a fresh Face ID / Touch ID every time, never the window.
    if (FRESH_PASSKEY_OPS.includes(op)) return bad(403, "this op needs a fresh passkey");
    // Inside the passkey window: a ticket with no new prompt, from the grant the
    // last verified assertion gave this page (this account, session and device).
    const client = b.client;
    if (!validDevice(client, "enrol")) return bad(400, "bad client");
    const g = await openGrant(String(b.grant ?? ""), d.pub, {
      uid: d.userId,
      sid: d.sid ?? "",
      client,
      windowMs: d.windowMs ?? 0,
      now: d.now,
    });
    if (!g) return bad(401, "approval window over");
    const iat = Math.floor((d.now ?? Date.now()) / 1000);
    // Never past the grant; at least a few seconds to reach the Mac, or ask again.
    const exp = Math.min(iat + VOICEPRINT_TICKET_TTL_S, g.exp);
    if (exp - iat < 5) return bad(401, "approval window over");
    const { ticket } = await signVoiceprintTicket(d.key, {
      op,
      device,
      uv: true,
      keepAudio,
      uid: d.userId,
      // Its own jti: each ticket is spent once on the Mac and once on lianki.com.
      jti: randomId(32),
      iat,
      exp,
    });
    return { status: 200, json: { ticket, exp, grantExp: g.exp } };
  }
  if (b.step === "options") {
    const { token, challenge } = await signChallenge(d.key, {
      op,
      device,
      uid: d.userId,
      keepAudio,
      now: d.now,
    });
    return {
      status: 200,
      json: {
        token,
        options: {
          challenge,
          rpId: d.rp.rpID,
          timeout: 60_000,
          userVerification: "required",
          allowCredentials: keys.map((k) => ({
            id: k.credentialID,
            type: "public-key",
            ...(k.transports ? { transports: k.transports.split(",") } : {}),
          })),
        },
      },
    };
  }
  if (b.step !== "verify") return bad(400, "bad step");
  const ch = await openChallenge(String(b.token ?? ""), d.pub, {
    op,
    device,
    uid: d.userId,
    keepAudio,
    now: d.now,
  });
  if (!ch) return bad(401, "challenge expired or not for this op");
  const resp = b.response as { id?: unknown } | undefined;
  const pk = keys.find((k) => typeof resp?.id === "string" && k.credentialID === resp.id);
  if (!pk) return bad(401, "not one of your passkeys");
  let r: Awaited<ReturnType<AssertionCheck>>;
  try {
    r = await d.check({
      response: resp,
      expectedChallenge: ch.challenge,
      expectedOrigin: d.rp.origins,
      expectedRPID: d.rp.rpID,
      credential: {
        id: pk.credentialID,
        publicKey: pk.publicKey,
        counter: pk.counter,
        ...(pk.transports ? { transports: pk.transports.split(",") } : {}),
      },
    });
  } catch {
    return bad(401, "passkey check failed");
  }
  // Face ID / Touch ID, not mere presence: the UV flag is required.
  if (!r.verified || !r.userVerified) return bad(401, "passkey check failed");
  // Once: the first good assertion spends the challenge; any replay stops here.
  if (!(await d.consume(ch.challenge, ch.exp))) return bad(401, "approval already used");
  await d.saveCounter(pk.id, r.newCounter);
  const { ticket, exp } = await signVoiceprintTicket(d.key, {
    op,
    device,
    uv: true,
    keepAudio,
    uid: d.userId,
    jti: ch.challenge,
    // The challenge's own lifetime, fixed when it was issued: never extended.
    iat: ch.iat,
    exp: ch.exp,
  });
  // The passkey window: one approval covers the voiceprint ops that follow on this
  // device, in this session, until grantExp. Only with a session and a device to bind it to.
  const client = b.client;
  // A fresh-only op (the voice-clone reference) opens no window.
  if (
    (d.windowMs ?? 0) > 0 &&
    d.sid &&
    validDevice(client, "enrol") &&
    !FRESH_PASSKEY_OPS.includes(op)
  ) {
    const g = await signGrant(d.key, {
      uid: d.userId,
      sid: d.sid,
      client,
      gid: ch.challenge,
      windowMs: d.windowMs!,
      now: d.now,
    });
    return { status: 200, json: { ticket, exp, grant: g.grant, grantExp: g.exp } };
  }
  return { status: 200, json: { ticket, exp } };
}
