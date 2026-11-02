#!/usr/bin/env bun
/**
 * Make the Ed25519 key pair for STT tickets (lib/stt-ticket.ts,
 * docs/local-stt.md "Off the tailnet"). The public key goes to a file on this
 * Mac (the STT server reads it); the private key is written to stdout only,
 * as a JWK, for `wrangler secret put` to read, and is kept nowhere else:
 *
 *   bun scripts/local-stt/ticket-key.ts | bunx wrangler secret put STT_TICKET_KEY
 *
 * It refuses to write the private key to a terminal. Re-running rotates the
 * pair (the old tickets die with the old public key).
 *
 *   --pub <path>   where the public key goes (default ~/.config/lianki-stt/ticket.pub)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { b64url } from "../../lib/stt-ticket";

const args = process.argv.slice(2);
const i = args.indexOf("--pub");
const pubPath = i >= 0 ? args[i + 1] : join(homedir(), ".config/lianki-stt/ticket.pub");

if (process.stdout.isTTY) {
  console.error("Refusing to print the private key to a terminal. Pipe it into wrangler:");
  console.error("  bun scripts/local-stt/ticket-key.ts | bunx wrangler secret put STT_TICKET_KEY");
  process.exit(2);
}

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

mkdirSync(dirname(pubPath), { recursive: true });
writeFileSync(pubPath, `${b64url(raw)}\n`, { mode: 0o644 });
console.error(`public key written to ${pubPath}; restart the STT server to load it`);
process.stdout.write(JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }));
