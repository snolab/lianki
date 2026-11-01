/**
 * Voiceprint tickets and the passkey approval behind them (lib/voiceprint-ticket.ts,
 * lib/voiceprint-approval.ts; docs/local-stt.md, "Voiceprint: who may enrol and
 * delete"), and the Mac's check of them (scripts/local-stt/ticket.py, run with
 * the STT venv where it exists).
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { b64url, fromB64url, importTicketKey, signSttTicket } from "@/lib/stt-ticket";
import { type ApprovalDeps, voiceprintApproval } from "@/lib/voiceprint-approval";
import {
  CHALLENGE_TTL_S,
  VOICEPRINT_AUD,
  importTicketVerifyKey,
  openPayload,
} from "@/lib/voiceprint-ticket";

async function keys() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  const raw = JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x });
  return {
    raw,
    key: await importTicketKey(raw),
    pub: await importTicketVerifyKey(raw),
    pubRaw: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey))),
  };
}

const NOW = 1_800_000_000_000;

async function deps(o: { uv?: boolean; verified?: boolean; passkeys?: number } = {}) {
  const k = await keys();
  const saved: [string, number][] = [];
  const used = new Set<string>();
  const checked: unknown[] = [];
  const d: ApprovalDeps = {
    key: k.key,
    pub: k.pub,
    userId: "owner-1",
    now: NOW,
    rp: { rpID: "lianki.com", origins: ["https://lianki.com"] },
    passkeys: async () =>
      Array.from({ length: o.passkeys ?? 1 }, (_, i) => ({
        id: `pk${i}`,
        credentialID: `cred${i}`,
        publicKey: "AAAA",
        counter: 4,
        transports: "internal,hybrid",
      })),
    check: async (a) => {
      checked.push(a);
      return { verified: o.verified ?? true, userVerified: o.uv ?? true, newCounter: 5 };
    },
    saveCounter: async (id, c) => void saved.push([id, c]),
    consume: async (ch) => (used.has(ch) ? false : (used.add(ch), true)),
  };
  return { d, k, saved, checked };
}

const payload = (ticket: string) =>
  JSON.parse(new TextDecoder().decode(fromB64url(ticket.split(".")[0]!)));

describe("voiceprint approval", () => {
  it("status: a read-only owner ticket, no passkey", async () => {
    const { d } = await deps();
    const r = await voiceprintApproval({ op: "status" }, d);
    expect(r.status).toBe(200);
    expect(payload(r.json.ticket as string)).toMatchObject({
      aud: VOICEPRINT_AUD,
      op: "status",
      device: "*",
      uv: false,
    });
  });

  it("enrol: options ask for user verification from his own passkeys", async () => {
    const { d } = await deps();
    const r = await voiceprintApproval({ op: "enrol", device: "iphone", step: "options" }, d);
    expect(r.status).toBe(200);
    const o = r.json.options as Record<string, unknown>;
    expect(o.userVerification).toBe("required");
    expect(o.rpId).toBe("lianki.com");
    expect(o.allowCredentials).toEqual([
      { id: "cred0", type: "public-key", transports: ["internal", "hybrid"] },
    ]);
    expect(typeof r.json.token).toBe("string");
  });

  it("no passkey, a bad op or device: refused", async () => {
    const none = await deps({ passkeys: 0 });
    expect(
      (await voiceprintApproval({ op: "enrol", device: "iphone", step: "options" }, none.d)).status,
    ).toBe(409);
    const { d } = await deps();
    expect((await voiceprintApproval({ op: "rename" }, d)).status).toBe(400);
    expect(
      (await voiceprintApproval({ op: "enrol", device: "*", step: "options" }, d)).status,
    ).toBe(400);
    expect(
      (await voiceprintApproval({ op: "enrol", device: "../x", step: "options" }, d)).status,
    ).toBe(400);
  });

  it("a verified assertion with UV gives a ticket for that op and device; jti = the challenge", async () => {
    const { d, saved, checked } = await deps();
    const o = await voiceprintApproval({ op: "enrol", device: "iphone", step: "options" }, d);
    const challenge = (o.json.options as { challenge: string }).challenge;
    const r = await voiceprintApproval(
      {
        op: "enrol",
        device: "iphone",
        step: "verify",
        token: o.json.token,
        response: { id: "cred0" },
      },
      d,
    );
    expect(r.status).toBe(200);
    expect(payload(r.json.ticket as string)).toMatchObject({
      aud: VOICEPRINT_AUD,
      op: "enrol",
      device: "iphone",
      uv: true,
      jti: challenge,
    });
    expect(checked[0]).toMatchObject({ expectedChallenge: challenge, expectedRPID: "lianki.com" });
    expect(saved).toEqual([["pk0", 5]]);
  });

  it("refused: no user verification, a failed check, another credential, another op or device, a late or edited token", async () => {
    for (const o of [{ uv: false }, { verified: false }]) {
      const { d } = await deps(o);
      const opt = await voiceprintApproval({ op: "delete", device: "*", step: "options" }, d);
      const r = await voiceprintApproval(
        {
          op: "delete",
          device: "*",
          step: "verify",
          token: opt.json.token,
          response: { id: "cred0" },
        },
        d,
      );
      expect(r.status).toBe(401);
    }
    const { d } = await deps();
    const opt = await voiceprintApproval({ op: "enrol", device: "iphone", step: "options" }, d);
    const v = (body: Record<string, unknown>, dd = d) =>
      voiceprintApproval(
        { step: "verify", response: { id: "cred0" }, token: opt.json.token, ...body },
        dd,
      );
    expect(
      (await v({ op: "enrol", device: "iphone", response: { id: "someone-else" } })).status,
    ).toBe(401);
    expect((await v({ op: "delete", device: "iphone" })).status).toBe(401);
    expect((await v({ op: "enrol", device: "android" })).status).toBe(401);
    expect(
      (
        await v(
          { op: "enrol", device: "iphone" },
          { ...d, now: NOW + (CHALLENGE_TTL_S + 5) * 1000 },
        )
      ).status,
    ).toBe(401);
    const t = String(opt.json.token);
    expect((await v({ op: "enrol", device: "iphone", token: `x${t}` })).status).toBe(401);
    // A challenge token signed with another key.
    const other = await deps();
    const foreign = await voiceprintApproval(
      { op: "enrol", device: "iphone", step: "options" },
      other.d,
    );
    expect((await v({ op: "enrol", device: "iphone", token: foreign.json.token })).status).toBe(
      401,
    );
  });

  it("one approval, one ticket: a replayed assertion fails, and the ticket's exp is fixed at issuance", async () => {
    const { d } = await deps();
    const opt = await voiceprintApproval({ op: "delete", device: "*", step: "options" }, d);
    const body = {
      op: "delete",
      device: "*",
      step: "verify",
      token: opt.json.token,
      response: { id: "cred0" },
    };
    const first = await voiceprintApproval(body, { ...d, now: NOW + 30_000 });
    expect(first.status).toBe(200);
    const p = payload(first.json.ticket as string);
    // The challenge's own lifetime: issued at NOW, not at the verify 30 s later.
    expect(p.iat).toBe(NOW / 1000);
    expect(p.exp).toBe(NOW / 1000 + 60);
    const replay = await voiceprintApproval(body, { ...d, now: NOW + 40_000 });
    expect(replay).toEqual({ status: 401, json: { error: "approval already used" } });
  });

  it("keepAudio is part of what the passkey approves", async () => {
    const { d } = await deps();
    const opt = await voiceprintApproval(
      { op: "enrol", device: "iphone", step: "options", keepAudio: false },
      d,
    );
    const v = (keepAudio: boolean) =>
      voiceprintApproval(
        {
          op: "enrol",
          device: "iphone",
          step: "verify",
          token: opt.json.token,
          response: { id: "cred0" },
          keepAudio,
        },
        d,
      );
    expect((await v(true)).status).toBe(401);
    const ok = await v(false);
    expect(payload(ok.json.ticket as string)).toMatchObject({ op: "enrol", keepAudio: false });
  });

  it("openPayload refuses another key's signature", async () => {
    const a = await keys();
    const b = await keys();
    const { ticket } = await signSttTicket(a.key);
    expect(await openPayload(ticket, a.pub)).not.toBeNull();
    expect(await openPayload(ticket, b.pub)).toBeNull();
  });
});

const PY = join(homedir(), ".cache/lianki-stt/venv/bin/python");
const hasVenv =
  existsSync(PY) && Bun.spawnSync([PY, "-I", "-c", "import cryptography"]).exitCode === 0;

describe.skipIf(!hasVenv)("the Mac's check of voiceprint tickets (ticket.py)", () => {
  it("takes a ticket only for its own op and device, once; an STT ticket never", async () => {
    const { d, k } = await deps();
    const status = (await voiceprintApproval({ op: "status" }, d)).json.ticket as string;
    const opt = await voiceprintApproval({ op: "delete", device: "*", step: "options" }, d);
    const del = (
      await voiceprintApproval(
        {
          op: "delete",
          device: "*",
          step: "verify",
          token: opt.json.token,
          response: { id: "cred0" },
        },
        d,
      )
    ).json.ticket as string;
    const stt = (await signSttTicket(k.key, { now: NOW })).ticket;
    const eo = await voiceprintApproval({ op: "enrol", device: "iphone", step: "options" }, d);
    const enrol = (
      await voiceprintApproval(
        {
          op: "enrol",
          device: "iphone",
          step: "verify",
          token: eo.json.token,
          response: { id: "cred0" },
        },
        d,
      )
    ).json.ticket as string;
    const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dir, "../scripts/local-stt"))})
from ticket import Tickets, VOICEPRINT_AUD, b64url_decode
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
key = Ed25519PublicKey.from_public_bytes(b64url_decode(${JSON.stringify(k.pubRaw)}))
t = Tickets(key, clock=lambda: ${NOW / 1000}, aud=VOICEPRINT_AUD)
a = json.loads(sys.stdin.read())
print(json.dumps([
  t.check(a["del"], {"op": "enrol", "device": "*", "uv": True}),
  t.check(a["del"], {"op": "delete", "device": "iphone", "uv": True}),
  t.check(a["status"], {"op": "delete", "device": "*", "uv": True}),
  t.check(a["stt"], {"op": "status"}),
  t.check(a["del"], {"op": "delete", "device": "*", "uv": True}),
  t.check(a["del"], {"op": "delete", "device": "*", "uv": True}),
  t.check(a["status"], {"op": "status"}),
  t.check(a["enrol"], {"op": "enrol", "device": "iphone", "uv": True, "keepAudio": True}),
  t.check(a["enrol"], {"op": "enrol", "device": "iphone", "uv": True, "keepAudio": False}),
]))
`;
    const r = Bun.spawnSync([PY, "-I", "-c", script], {
      stdin: new TextEncoder().encode(JSON.stringify({ del, status, stt, enrol })),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual([
      "wrong op",
      "wrong device",
      "wrong op",
      "wrong aud",
      null,
      "replayed",
      null,
      "wrong keepAudio",
      null,
    ]);
  });
});
