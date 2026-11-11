/**
 * The local STT server's tunnel listener (scripts/local-stt/server.py
 * --public-port; docs/local-stt.md "Off the tailnet"): every handshake is
 * refused before the upgrade unless it carries a lianki.com Origin and a good
 * ticket, signed here with lib/stt-ticket.ts (so the two languages agree).
 * Uses the "fake" engine, so it needs only the STT venv (websockets, numpy,
 * cryptography), not the model. Skipped where the venv is missing (CI).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { b64url, importTicketKey, signSttTicket } from "../lib/stt-ticket";

const PY = join(homedir(), ".cache/lianki-stt/venv/bin/python");
const hasVenv =
  existsSync(PY) &&
  Bun.spawnSync([PY, "-I", "-c", "import websockets, numpy, cryptography"]).exitCode === 0;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const PUBLIC = PORT + 1;
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

/** A raw upgrade request; resolves with the status code of the answer. */
function handshake(headers: Record<string, string>, path = "/"): Promise<number> {
  return new Promise((res, rej) => {
    const s = connect(PUBLIC, "127.0.0.1");
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
      `GET ${path} HTTP/1.1`,
      `Host: stt.lianki.com`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    s.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

/** A real socket with the ticket as subprotocol; resolves with the first message, or "closed". */
function open(ticket: string, origin = ORIGIN): Promise<{ ws: WebSocket; first: string }> {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PUBLIC}/`, {
      protocols: ["lianki-stt", ticket],
      headers: { origin },
    } as never);
    ws.onmessage = (e) => res({ ws, first: String(e.data) });
    ws.onerror = () => res({ ws, first: "closed" });
    ws.onclose = () => res({ ws, first: "closed" });
  });
}

describe.skipIf(!hasVenv)("local STT tunnel listener: the ticket gate", () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let k: Awaited<ReturnType<typeof keys>>;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    k = await keys();
    const dir = mkdtempSync(join(tmpdir(), "stt-gate-"));
    const pubFile = join(dir, "ticket.pub");
    writeFileSync(pubFile, `${k.pub}\n`, { mode: 0o644 });
    proc = Bun.spawn(
      [
        PY,
        "-I",
        resolve(import.meta.dir, "../scripts/local-stt/server.py"),
        "--engine",
        "fake",
        "--port",
        String(PORT),
        "--public-port",
        String(PUBLIC),
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
    expect(out).toContain("tickets required");
    reader.releaseLock();
  }, 30_000);
  afterAll(() => {
    for (const s of sockets) s.close();
    proc?.kill();
  });

  const ticket = async (o: Parameters<typeof signSttTicket>[1] = {}) =>
    (await signSttTicket(k.sign, o)).ticket;

  it("no ticket: 401, no upgrade", async () => {
    expect(await handshake({ Origin: ORIGIN })).toBe(401);
    expect(await handshake({ Origin: ORIGIN, "Sec-WebSocket-Protocol": "lianki-stt" })).toBe(401);
  });

  it("no /health on the tunnel listener", async () => {
    expect(await handshake({ Origin: ORIGIN }, "/health")).toBe(401);
  });

  it("a wrong Origin: 403, even with a good ticket", async () => {
    const t = await ticket();
    expect(
      await handshake({
        Origin: "https://evil.example",
        "Sec-WebSocket-Protocol": `lianki-stt, ${t}`,
      }),
    ).toBe(403);
    expect(await handshake({ "Sec-WebSocket-Protocol": `lianki-stt, ${t}` })).toBe(403);
  });

  it("a ticket from another key, an expired one, a wrong aud: 401", async () => {
    const other = await keys();
    const bad = [
      (await signSttTicket(other.sign)).ticket,
      await ticket({ now: Date.now() - 120_000 }),
      await ticket({ aud: "lianki-push" }),
      "not-a.ticket",
    ];
    for (const t of bad) {
      expect(
        await handshake({ Origin: ORIGIN, "Sec-WebSocket-Protocol": `lianki-stt, ${t}` }),
      ).toBe(401);
    }
  });

  it("a good ticket upgrades and the server says ready; the same ticket again is a replay", async () => {
    const t = await ticket();
    const a = await open(t);
    sockets.push(a.ws);
    expect(JSON.parse(a.first)).toMatchObject({ t: "ready", engine: "fake" });
    expect(a.ws.protocol).toBe("lianki-stt");
    expect(await handshake({ Origin: ORIGIN, "Sec-WebSocket-Protocol": `lianki-stt, ${t}` })).toBe(
      401,
    );
  });

  it("at most two sockets at once: the third is 503", async () => {
    const b = await open(await ticket());
    sockets.push(b.ws);
    expect(JSON.parse(b.first).t).toBe("ready");
    expect(
      await handshake({
        Origin: ORIGIN,
        "Sec-WebSocket-Protocol": `lianki-stt, ${await ticket()}`,
      }),
    ).toBe(503);
    // One closes: a slot is free again.
    const closed = new Promise((r) => (b.ws.onclose = r));
    b.ws.close();
    await closed;
    const c = await open(await ticket());
    sockets.push(c.ws);
    expect(JSON.parse(c.first).t).toBe("ready");
  });

  it("ticket.py's own tests pass", () => {
    const r = Bun.spawnSync([
      PY,
      "-I",
      resolve(import.meta.dir, "../scripts/local-stt/test_ticket.py"),
    ]);
    expect({ code: r.exitCode, err: r.exitCode ? r.stderr.toString() : "" }).toEqual({
      code: 0,
      err: "",
    });
  });
});

/** Start server.py with the fake engine; resolves with its output up to "listening". */
async function startServer(args: string[]) {
  const proc = Bun.spawn(
    [
      PY,
      "-I",
      resolve(import.meta.dir, "../scripts/local-stt/server.py"),
      "--engine",
      "fake",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  while (!out.includes("listening")) {
    const { value, done } = await reader.read();
    if (done) {
      const err = await new Response(proc.stderr as ReadableStream).text();
      throw new Error(`server exited: ${out}\n${err.slice(-500)}`);
    }
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { proc, out };
}

describe.skipIf(!hasVenv)("local STT tunnel listener: starting it", () => {
  it("a taken tunnel port is logged and the tailnet listener stays up", async () => {
    const port = PORT + 10;
    const taken = Bun.listen({ hostname: "127.0.0.1", port: port + 1, socket: { data() {} } });
    const dir = mkdtempSync(join(tmpdir(), "stt-gate-"));
    writeFileSync(join(dir, "ticket.pub"), `${(await keys()).pub}\n`, { mode: 0o644 });
    const s = await startServer([
      "--port",
      String(port),
      "--public-port",
      String(port + 1),
      "--ticket-pubkey",
      join(dir, "ticket.pub"),
    ]);
    try {
      expect(s.out).toContain(`public listener off: cannot listen on 127.0.0.1:${port + 1}`);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toMatchObject({ ok: true, engine: "fake" });
      expect(s.proc.exitCode).toBeNull(); // still running
    } finally {
      s.proc.kill();
      taken.stop(true);
    }
  }, 30_000);

  it("tunnel.sh's config file turns it on, with the key file it names", async () => {
    const port = PORT + 20;
    const dir = mkdtempSync(join(tmpdir(), "stt-gate-"));
    const k2 = await keys();
    writeFileSync(join(dir, "custom.pub"), `${k2.pub}\n`, { mode: 0o644 });
    const conf = join(dir, "public.json");
    writeFileSync(conf, JSON.stringify({ port: port + 1, pubkey: join(dir, "custom.pub") }), {
      mode: 0o644,
    });
    const s = await startServer(["--port", String(port), "--public-config", conf]);
    try {
      expect(s.out).toContain(`public listener on ws://127.0.0.1:${port + 1}`);
      const { ticket } = await signSttTicket(k2.sign);
      const first = await new Promise<string>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port + 1}/`, {
          protocols: ["lianki-stt", ticket],
          headers: { origin: ORIGIN },
        } as never);
        ws.onmessage = (e) => {
          res(String(e.data));
          ws.close();
        };
        ws.onclose = () => res("closed");
      });
      expect(JSON.parse(first)).toMatchObject({ t: "ready" });
    } finally {
      s.proc.kill();
    }
  }, 30_000);

  it("a config file naming a missing key: no tunnel listener (fail closed), tailnet up", async () => {
    const port = PORT + 30;
    const dir = mkdtempSync(join(tmpdir(), "stt-gate-"));
    const conf = join(dir, "public.json");
    writeFileSync(conf, JSON.stringify({ port: port + 1, pubkey: join(dir, "missing.pub") }));
    const s = await startServer(["--port", String(port), "--public-config", conf]);
    try {
      expect(s.out).toContain("public listener off: no usable ticket key");
      expect(s.out).not.toContain("public listener on");
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
    } finally {
      s.proc.kill();
    }
  }, 30_000);
});

/**
 * public.json and the ticket key decide who reaches the decoder from the
 * internet: a symlink, or a file someone else can write, never turns the
 * tunnel listener on. (Not owned by this user: test_ticket.py, which can fake
 * the uid; a test cannot chown.) The tailnet listener stays up in every case.
 */
describe.skipIf(!hasVenv)("local STT tunnel listener: refusing unsafe files", () => {
  let n = 0;
  /** dir has ticket.pub (0644) and public.json (0644) naming it; `prepare` makes dir/conf. */
  async function attempt(prepare: (dir: string, port: number) => void, reason: RegExp) {
    const port = PORT + 40 + 2 * n++;
    const dir = mkdtempSync(join(tmpdir(), "stt-gate-"));
    writeFileSync(join(dir, "ticket.pub"), `${(await keys()).pub}\n`);
    chmodSync(join(dir, "ticket.pub"), 0o644);
    writeFileSync(
      join(dir, "public.json"),
      JSON.stringify({ port: port + 1, pubkey: join(dir, "ticket.pub") }),
    );
    chmodSync(join(dir, "public.json"), 0o644);
    prepare(dir, port);
    const s = await startServer(["--port", String(port), "--public-config", join(dir, "conf")]);
    try {
      expect(s.out).toMatch(reason);
      expect(s.out).not.toContain("public listener on");
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
    } finally {
      s.proc.kill();
    }
  }
  /** A real file (not a link) with public.json's content, in this mode. */
  const copyConf = (dir: string, mode = 0o644) => {
    writeFileSync(join(dir, "conf"), readFileSync(join(dir, "public.json")));
    chmodSync(join(dir, "conf"), mode);
  };

  it("the control: a safe public.json and key turn it on", async () => {
    const port = PORT + 90;
    const dir = mkdtempSync(join(tmpdir(), "stt-gate-"));
    writeFileSync(join(dir, "ticket.pub"), `${(await keys()).pub}\n`);
    chmodSync(join(dir, "ticket.pub"), 0o644);
    writeFileSync(
      join(dir, "conf"),
      JSON.stringify({ port: port + 1, pubkey: join(dir, "ticket.pub") }),
    );
    chmodSync(join(dir, "conf"), 0o600);
    const s = await startServer(["--port", String(port), "--public-config", join(dir, "conf")]);
    s.proc.kill();
    expect(s.out).toContain("public listener on");
  }, 30_000);

  it("public.json as a symlink", async () => {
    await attempt(
      (dir) => symlinkSync(join(dir, "public.json"), join(dir, "conf")),
      /public listener off: .*conf is a symlink/,
    );
  }, 30_000);

  it("public.json group-writable", async () => {
    await attempt((dir) => copyConf(dir, 0o664), /conf is group- or world-writable/);
  }, 30_000);

  it("public.json world-writable", async () => {
    await attempt((dir) => copyConf(dir, 0o646), /conf is group- or world-writable/);
  }, 30_000);

  it("the ticket key as a symlink", async () => {
    await attempt((dir, port) => {
      symlinkSync(join(dir, "ticket.pub"), join(dir, "link.pub"));
      writeFileSync(
        join(dir, "conf"),
        JSON.stringify({ port: port + 1, pubkey: join(dir, "link.pub") }),
      );
      chmodSync(join(dir, "conf"), 0o644);
    }, /no usable ticket key .*the ticket key is a symlink/);
  }, 30_000);

  it("the ticket key group- or world-writable", async () => {
    await attempt((dir) => {
      copyConf(dir);
      chmodSync(join(dir, "ticket.pub"), 0o666);
    }, /no usable ticket key .*the ticket key is group- or world-writable/);
  }, 30_000);

  it("the ticket key from --ticket-pubkey is checked too", async () => {
    const port = PORT + 80;
    const dir = mkdtempSync(join(tmpdir(), "stt-gate-"));
    writeFileSync(join(dir, "ticket.pub"), `${(await keys()).pub}\n`);
    chmodSync(join(dir, "ticket.pub"), 0o664);
    const s = await startServer([
      "--port",
      String(port),
      "--public-port",
      String(port + 1),
      "--ticket-pubkey",
      join(dir, "ticket.pub"),
      "--public-config",
      "",
    ]);
    try {
      expect(s.out).toContain("the ticket key is group- or world-writable");
      expect(s.out).not.toContain("public listener on");
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
    } finally {
      s.proc.kill();
    }
  }, 30_000);
});
