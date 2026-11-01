import { NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import { passkeyRelyingParty } from "@/lib/passkey";
import { importTicketKey } from "@/lib/stt-ticket";
import { importTicketVerifyKey } from "@/lib/voiceprint-ticket";
import { type StoredPasskey, voiceprintApproval } from "@/lib/voiceprint-approval";

/**
 * Voiceprint tickets for the owner's local STT server (lib/voiceprint-approval.ts,
 * docs/local-stt.md "Voiceprint: who may enrol and delete"). Owner session
 * only (404 for anyone else, as every /api/dev route). Enrol and delete need
 * a fresh passkey assertion with user verification; status only the session.
 * 503 without STT_TICKET_KEY or off D1. POST, so nothing caches or prefetches it.
 */
const b64 = (s: string) => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

export const POST = async (req: Request) => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email) || !user?.id)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const raw = process.env.STT_TICKET_KEY;
  if (!raw || dbBackend() !== "d1")
    return NextResponse.json({ error: "voiceprint tickets are off" }, { status: 503 });
  let key: CryptoKey;
  let pub: CryptoKey;
  try {
    key = await importTicketKey(raw);
    pub = await importTicketVerifyKey(raw);
  } catch {
    return NextResponse.json({ error: "voiceprint tickets are off" }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const env = process.env.NODE_ENV;
  const rp = passkeyRelyingParty(
    process.env.BETTER_AUTH_BASE_URL ?? process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL,
    env !== "development" && env !== "test",
  );
  const origins = rp.origin ?? [new URL(req.url).origin];
  const db = getD1();
  const userId = user.id as string;
  const out = await voiceprintApproval(body, {
    key,
    pub,
    userId,
    rp: { rpID: rp.rpID, origins },
    passkeys: async () =>
      (
        await db
          .prepare(
            "SELECT id, credentialID, publicKey, counter, transports FROM passkey WHERE userId = ?",
          )
          .bind(userId)
          .all<StoredPasskey>()
      ).results,
    check: async (a) => {
      const r = await verifyAuthenticationResponse({
        response: a.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
        expectedChallenge: a.expectedChallenge,
        expectedOrigin: a.expectedOrigin,
        expectedRPID: a.expectedRPID,
        credential: {
          id: a.credential.id,
          // better-auth keeps the COSE key base64-encoded (@better-auth/passkey).
          publicKey: b64(a.credential.publicKey),
          counter: a.credential.counter,
          transports: a.credential.transports as never,
        },
        requireUserVerification: true,
      });
      return {
        verified: r.verified,
        userVerified: r.authenticationInfo.userVerified,
        newCounter: r.authenticationInfo.newCounter,
      };
    },
    saveCounter: async (id, counter) => {
      await db.prepare("UPDATE passkey SET counter = ? WHERE id = ?").bind(counter, id).run();
    },
  });
  return NextResponse.json(out.json, {
    status: out.status,
    headers: { "cache-control": "no-store" },
  });
};
