/**
 * STT tickets (lib/stt-ticket.ts): signed on lianki.com with the Ed25519
 * private key, verified with the public key only. The deployed verifier is
 * scripts/local-stt/ticket.py (its own tests: test_ticket.py, and
 * unit/local-stt-gate.test.ts across the two languages).
 */
import { describe, expect, test } from "bun:test";
import {
  STT_TICKET_AUD,
  b64url,
  fromB64url,
  importTicketKey,
  importTicketPublicKey,
  signSttTicket,
  verifySttTicket,
} from "../lib/stt-ticket";

const NOW = 1_800_000_000_000;

async function pair() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey));
  return {
    secret: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }),
    pub: b64url(raw),
  };
}

describe("STT tickets", () => {
  test("a fresh ticket verifies once, then is a replay", async () => {
    const k = await pair();
    const { ticket, exp } = await signSttTicket(await importTicketKey(k.secret), { now: NOW });
    expect(exp).toBe(NOW / 1000 + 60);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // a valid subprotocol token
    const pub = await importTicketPublicKey(k.pub);
    const seen = new Map<string, number>();
    const first = await verifySttTicket(ticket, pub, seen, NOW + 1000);
    expect(first.ok && first.payload.aud).toBe(STT_TICKET_AUD);
    expect(await verifySttTicket(ticket, pub, seen, NOW + 2000)).toEqual({
      ok: false,
      error: "replayed",
    });
  });

  test("each ticket has its own jti", async () => {
    const key = await importTicketKey((await pair()).secret);
    const a = await signSttTicket(key, { now: NOW });
    const b = await signSttTicket(key, { now: NOW });
    expect(a.ticket).not.toBe(b.ticket);
  });

  test("expired after 60 s (plus 5 s of clock skew)", async () => {
    const k = await pair();
    const { ticket } = await signSttTicket(await importTicketKey(k.secret), { now: NOW });
    const pub = await importTicketPublicKey(k.pub);
    expect((await verifySttTicket(ticket, pub, new Map(), NOW + 64_000)).ok).toBe(true);
    expect(await verifySttTicket(ticket, pub, new Map(), NOW + 66_000)).toEqual({
      ok: false,
      error: "expired",
    });
  });

  test("wrong aud is refused", async () => {
    const k = await pair();
    const { ticket } = await signSttTicket(await importTicketKey(k.secret), {
      now: NOW,
      aud: "lianki-push",
    });
    const r = await verifySttTicket(ticket, await importTicketPublicKey(k.pub), new Map(), NOW);
    expect(r).toEqual({ ok: false, error: "wrong aud" });
  });

  test("a ticket from another key is refused", async () => {
    const mine = await pair();
    const theirs = await pair();
    const { ticket } = await signSttTicket(await importTicketKey(theirs.secret), { now: NOW });
    const r = await verifySttTicket(ticket, await importTicketPublicKey(mine.pub), new Map(), NOW);
    expect(r).toEqual({ ok: false, error: "bad signature" });
  });

  test("a payload edited after signing is refused", async () => {
    const k = await pair();
    const { ticket } = await signSttTicket(await importTicketKey(k.secret), { now: NOW });
    const [body, sig] = ticket.split(".");
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    p.exp += 3600;
    const forged = `${b64url(new TextEncoder().encode(JSON.stringify(p)))}.${sig}`;
    const r = await verifySttTicket(forged, await importTicketPublicKey(k.pub), new Map(), NOW);
    expect(r).toEqual({ ok: false, error: "bad signature" });
  });

  test("a long-lived ticket is refused even when signed", async () => {
    const k = await pair();
    const { ticket } = await signSttTicket(await importTicketKey(k.secret), {
      now: NOW,
      ttlS: 3600,
    });
    const r = await verifySttTicket(ticket, await importTicketPublicKey(k.pub), new Map(), NOW);
    expect(r).toEqual({ ok: false, error: "bad lifetime" });
  });

  test("garbage is malformed, not a throw", async () => {
    const pub = await importTicketPublicKey((await pair()).pub);
    for (const t of ["", "x", "a.b.c", "!!.??"]) {
      expect(await verifySttTicket(t, pub, new Map(), NOW)).toEqual({
        ok: false,
        error: "malformed",
      });
    }
  });

  test("the secret must be an Ed25519 private JWK", async () => {
    const k = await pair();
    await expect(
      importTicketKey(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "AA" })),
    ).rejects.toThrow();
    await expect(importTicketKey(JSON.stringify({ kty: "oct", k: "AA" }))).rejects.toThrow();
    await expect(importTicketKey(k.secret)).resolves.toBeDefined();
  });
});
