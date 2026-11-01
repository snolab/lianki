/**
 * The owner's passkey approval for a voiceprint op (docs/local-stt.md,
 * "Voiceprint: who may enrol and delete"), without the request plumbing so it
 * is unit-tested: app/api/dev/voiceprint-ticket is the route.
 *
 *   POST {op:"status"}                                   → {ticket}  (owner session only)
 *   POST {op:"enrol"|"delete", device, step:"options"}   → {options, token}
 *   POST {op, device, step:"verify", token, response}    → {ticket}  (after Face ID / Touch ID)
 *
 * `options` are WebAuthn request options (JSON form) for the owner's own
 * passkeys with userVerification "required"; `token` carries the challenge,
 * signed (lib/voiceprint-ticket.ts). The assertion must verify against one of
 * the owner's passkeys with the UV flag set; then the Mac gets a 60 s ticket
 * for that op and device whose jti is the challenge (single use there).
 */
import {
  type VoiceprintOp,
  openChallenge,
  signChallenge,
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
  rp: { rpID: string; origins: string[] };
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
  if (op !== "enrol" && op !== "delete") return bad(400, "bad op");
  const device = b.device;
  if (!validDevice(device, op)) return bad(400, "bad device");
  const keys = await d.passkeys();
  if (!keys.length) return bad(409, "no passkey: add one on the profile page first");
  if (b.step === "options") {
    const { token, challenge } = await signChallenge(d.key, {
      op,
      device,
      uid: d.userId,
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
  await d.saveCounter(pk.id, r.newCounter);
  const { ticket, exp } = await signVoiceprintTicket(d.key, {
    op,
    device,
    uv: true,
    jti: ch.challenge,
    now: d.now,
  });
  return { status: 200, json: { ticket, exp } };
}
