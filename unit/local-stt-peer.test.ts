/**
 * The speech server's peer listener (scripts/local-stt/server.py --peer-port;
 * docs/local-stt.md, "Lianki's speech servers for everyone"): other accounts'
 * sessions, bridged from WebRTC by stt-peer. Refused before the upgrade
 * unless a lianki.com Origin and a v2 ticket (lib/stt-ticket.ts
 * signSttTicketV2, so the two languages agree); a v1 ticket never opens it.
 * The ticket's limits hold (utterance, session); none of the owner's
 * voiceprint features answer there. The fake engine (no model); skipped
 * where the STT venv is missing (CI).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { b64url, importTicketKey, signSttTicket, signSttTicketV2 } from "../lib/stt-ticket";

const PY = join(homedir(), ".cache/lianki-stt/venv/bin/python");
const hasVenv =
  existsSync(PY) &&
  Bun.spawnSync([PY, "-I", "-c", "import websockets, numpy, cryptography"]).exitCode === 0;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const PEER = PORT + 2;
const ORIGIN = "https://lianki.com";

async function keys() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", p.publicKey));
  const sign = await importTicketKey(
    JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }),
  );
  return { sign, pub: b64url(raw) };
}

function handshake(headers: Record<string, string>): Promise<number> {
  return new Promise((res, rej) => {
    const s = connect(PEER, "127.0.0.1");
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
      if (m) {
        s.destroy();
        res(Number(m[1]));
      }
    });
    s.on("error", rej);
    const lines = [
      "GET / HTTP/1.1",
      "Host: 127.0.0.1",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    s.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

type Open = {
  ws: WebSocket;
  msgs: Record<string, unknown>[];
  next: () => Promise<Record<string, unknown>>;
  closed: Promise<number>;
};

function open(ticket: string): Promise<Open> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PEER}/`, {
      protocols: ["lianki-stt2", ticket],
      headers: { origin: ORIGIN },
    } as never);
    ws.binaryType = "arraybuffer";
    const msgs: Record<string, unknown>[] = [];
    const waiters: ((m: Record<string, unknown>) => void)[] = [];
    let closeCode: (n: number) => void = () => {};
    const closed = new Promise<number>((r) => (closeCode = r));
    const next = () =>
      new Promise<Record<string, unknown>>((r) => {
        const m = msgs.shift();
        if (m) r(m);
        else waiters.push(r);
      });
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      const w = waiters.shift();
      if (w) w(m);
      else msgs.push(m);
    };
    ws.onopen = () => res({ ws, msgs, next, closed });
    ws.onerror = () => rej(new Error("refused"));
    ws.onclose = (e) => closeCode(e.code);
  });
}

/** Half a second of 16 kHz int16 silence behind the frame tag. */
const halfSecond = () => {
  const b = new Uint8Array(1 + 8000 * 2);
  b[0] = 1;
  return b;
};

describe.skipIf(!hasVenv)("speech server peer listener: other accounts, v2 tickets", () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let k: Awaited<ReturnType<typeof keys>>;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    k = await keys();
    const dir = mkdtempSync(join(tmpdir(), "stt-peer-"));
    const pubFile = join(dir, "ticket.pub");
    writeFileSync(pubFile, `${k.pub}\n`, { mode: 0o644 });
    proc = Bun.spawn(
      [
        PY,
        "-I",
        resolve(import.meta.dir, "../scripts/local-stt/server.py"),
        "--engine",
        "fake",
        "--speaker",
        "",
        "--port",
        String(PORT),
        "--public-config",
        "",
        "--peer-port",
        String(PEER),
        "--peer-max",
        "2",
        "--ticket-pubkey",
        pubFile,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let out = "";
    while (!out.includes("listening")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited: ${out}`);
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("peer listener on");
    reader.releaseLock();
  }, 30_000);
  afterAll(() => {
    for (const s of sockets) s.close();
    proc?.kill();
  });

  const v2 = async (lim = { utt: 40, sess: 900 }) =>
    (await signSttTicketV2(k.sign, { sub: "acct_1", lim })).ticket;

  it("no ticket, a v1 ticket, another key's: 401; a wrong Origin: 403", async () => {
    expect(await handshake({ Origin: ORIGIN })).toBe(401);
    const v1 = (await signSttTicket(k.sign)).ticket;
    expect(
      await handshake({ Origin: ORIGIN, "Sec-WebSocket-Protocol": `lianki-stt2, ${v1}` }),
    ).toBe(401);
    const other = (
      await signSttTicketV2((await keys()).sign, { sub: "a", lim: { utt: 40, sess: 900 } })
    ).ticket;
    expect(
      await handshake({ Origin: ORIGIN, "Sec-WebSocket-Protocol": `lianki-stt2, ${other}` }),
    ).toBe(401);
    expect(
      await handshake({
        Origin: "https://evil.example",
        "Sec-WebSocket-Protocol": `lianki-stt2, ${await v2()}`,
      }),
    ).toBe(403);
    // The owner's subprotocol is not this listener's.
    expect(
      await handshake({ Origin: ORIGIN, "Sec-WebSocket-Protocol": `lianki-stt, ${await v2()}` }),
    ).toBe(401);
  });

  it("a v2 ticket upgrades once; the ready has no speaker check; voiceprint ops refused", async () => {
    const t = await v2();
    const a = await open(t);
    sockets.push(a.ws);
    const ready = await a.next();
    expect(ready).toMatchObject({ t: "ready", engine: "fake" });
    expect(ready.speaker).toBeUndefined();
    expect(a.ws.protocol).toBe("lianki-stt2");
    a.ws.send(JSON.stringify({ t: "voiceprint", op: "status", rid: "r1" }));
    expect(await a.next()).toMatchObject({
      t: "voiceprint",
      rid: "r1",
      ok: false,
      error: "not on this route",
    });
    a.ws.send(JSON.stringify({ t: "filter", on: true }));
    expect(await a.next()).toEqual({ t: "filter", on: false });
    expect(await handshake({ Origin: ORIGIN, "Sec-WebSocket-Protocol": `lianki-stt2, ${t}` })).toBe(
      401,
    );
    a.ws.close();
  });

  it("the ticket's utterance limit holds: audio past it is not kept", async () => {
    const a = await open(await v2({ utt: 2, sess: 900 }));
    sockets.push(a.ws);
    await a.next(); // ready
    a.ws.send(JSON.stringify({ t: "begin", id: 1 }));
    for (let i = 0; i < 6; i++) a.ws.send(halfSecond());
    a.ws.send(JSON.stringify({ t: "end", id: 1 }));
    let m = await a.next();
    while (m.t !== "final") m = await a.next();
    expect(m.audioMs).toBe(2000);
    expect(m.speaker).toBeUndefined();
    expect(m.speakerProof).toBeUndefined();
    a.ws.close();
  });

  it("the ticket's session length holds: closed with 4408", async () => {
    const a = await open(await v2({ utt: 40, sess: 1 }));
    sockets.push(a.ws);
    expect(await a.closed).toBe(4408);
  });

  it("at most --peer-max sockets at once: then 503", async () => {
    const a = await open(await v2());
    const b = await open(await v2());
    sockets.push(a.ws, b.ws);
    await a.next();
    await b.next();
    expect(
      await handshake({ Origin: ORIGIN, "Sec-WebSocket-Protocol": `lianki-stt2, ${await v2()}` }),
    ).toBe(503);
  });

  it("an account's voiceprint folder is a hash of its id under accounts/, never the root", () => {
    const r = Bun.spawnSync([
      PY,
      "-I",
      "-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import server; " +
        "p = server.account_store('/vp', 'acct_1'); print(p); " +
        "assert p.startswith('/vp/accounts/') and 'acct_1' not in p; " +
        "assert server.account_store('/vp', 'acct_2') != p\n" +
        "try:\n server.account_store('/vp', '../x')\nexcept ValueError: print('refused')",
      resolve(import.meta.dir, "../scripts/local-stt"),
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("refused");
  });
});
