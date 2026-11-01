/**
 * scripts/dev/eval-socket.ts against a fake WebSocket: the token file follows
 * the hub's renewals on every socket holding the grant (a freshly paired one
 * too), and a saved token whose file says it expired is still tried with the
 * hub before pairing (docs/monitoring.md, "Renewal").
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lianki-eval-socket-"));
const EVAL = join(dir, "eval.json");
const CHAT = join(dir, "chat.json");
process.env.LIANKI_EVAL_TOKEN_FILE = EVAL;
process.env.LIANKI_CHAT_TOKEN_FILE = CHAT;

class FakeWS extends EventTarget {
  static all: FakeWS[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(
    public url: string,
    public opts?: { headers?: Record<string, string> },
  ) {
    super();
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  emit(m: unknown) {
    const e = new MessageEvent("message", { data: JSON.stringify(m) });
    this.onmessage?.(e);
    this.dispatchEvent(e);
  }
  shut(code: number, reason = "") {
    this.onclose?.({ code, reason });
  }
}
const realWS = globalThis.WebSocket;
globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
const errLog = console.error;
console.error = () => {};
afterAll(() => {
  globalThis.WebSocket = realWS;
  console.error = errLog;
  rmSync(dir, { recursive: true, force: true });
});

const sock = await import("@/scripts/dev/eval-socket");
const { grantFileBody } = await import("@/scripts/dev/eval-grant");
const last = () => FakeWS.all.at(-1) as FakeWS;
const fileUntil = () => JSON.parse(readFileSync(EVAL, "utf8")).until as string;
const tick = () => new Promise((r) => setTimeout(r, 0));
const HOUR = 3_600_000;

beforeEach(() => {
  FakeWS.all = [];
  rmSync(EVAL, { force: true });
  rmSync(CHAT, { force: true });
});

describe("eval-socket: the token file follows renewals", () => {
  it("a freshly paired socket follows its grant's renewals (a long serve)", async () => {
    const c = sock.controller({ label: "agent" });
    const p = c.pair();
    const ws = last();
    expect(ws.opts).toBeUndefined();
    ws.emit({ type: "pending", code: "abcd" });
    const t1 = Date.now() + 8 * HOUR;
    ws.emit({ type: "approved", token: "tok1", until: t1, scope: "eval" });
    await p;
    expect(fileUntil()).toBe(new Date(t1).toISOString());
    const t2 = t1 + 6 * HOUR;
    ws.emit({ type: "renewed", until: t2, count: 1 });
    expect(fileUntil()).toBe(new Date(t2).toISOString());
  });

  it("a resumed socket's approved and renewed move the file; another token's file is left", async () => {
    writeFileSync(EVAL, grantFileBody("tok1", Date.now() + HOUR));
    const c = sock.controller({ label: "agent" });
    const r = c.resumeEval("tok1");
    const ws = last();
    expect(ws.opts?.headers?.["x-debug-token"]).toBe("tok1");
    const t1 = Date.now() + 8 * HOUR;
    ws.emit({ type: "approved", scope: "eval", until: t1, resumed: true });
    expect("ws" in (await r)).toBe(true);
    expect(fileUntil()).toBe(new Date(t1).toISOString());
    ws.emit({ type: "renewed", until: t1 + HOUR });
    expect(fileUntil()).toBe(new Date(t1 + HOUR).toISOString());
    // The file now holds another grant: this socket's renewals leave it alone.
    writeFileSync(EVAL, grantFileBody("tok2", t1));
    ws.emit({ type: "renewed", until: t1 + 2 * HOUR });
    expect(fileUntil()).toBe(new Date(t1).toISOString());
    // Junk and unrelated messages change nothing.
    ws.dispatchEvent(new MessageEvent("message", { data: '"approved" but not json' }));
    ws.emit({ type: "said" });
    expect(fileUntil()).toBe(new Date(t1).toISOString());
  });
});

describe("eval-socket: the file's until is a hint, the hub decides", () => {
  it("a token whose file says expired is tried with the hub, not dropped", async () => {
    writeFileSync(EVAL, grantFileBody("tok1", Date.now() - HOUR));
    expect(sock.loadEvalToken()).toBe("tok1");
    const c = sock.controller({ label: "agent" });
    const got = c.evalSocket();
    await tick();
    const ws = last();
    expect(ws.opts?.headers?.["x-debug-token"]).toBe("tok1");
    const t1 = Date.now() + 5 * HOUR;
    ws.emit({ type: "approved", scope: "eval", until: t1, resumed: true });
    expect((await got) as unknown).toBe(ws);
    expect(FakeWS.all).toHaveLength(1);
    expect(fileUntil()).toBe(new Date(t1).toISOString());
  });

  it("only the hub's 4498 drops it, and then it pairs (once)", async () => {
    writeFileSync(EVAL, grantFileBody("tok1", Date.now() - HOUR));
    const c = sock.controller({ label: "agent" });
    const got = c.evalSocket();
    await tick();
    last().shut(4498);
    await tick();
    expect(existsSync(EVAL)).toBe(false);
    const pairing = last();
    expect(pairing.opts).toBeUndefined();
    pairing.emit({ type: "approved", token: "tok2", until: Date.now() + HOUR, scope: "eval" });
    expect((await got) as unknown).toBe(pairing);
    expect(sock.loadEvalToken()).toBe("tok2");
    // With that grant gone too, a second pairing in the same process is refused.
    rmSync(EVAL, { force: true });
    await expect(c.evalSocket()).rejects.toThrow("already asked the owner once");
  });

  it("--no-pair fails instead of pairing; no file and no token = undefined", async () => {
    expect(sock.loadEvalToken()).toBeUndefined();
    await expect(sock.controller({ label: "a", noPair: true }).evalSocket()).rejects.toThrow(
      "--no-pair",
    );
  });
});

describe("eval-socket: the rest of the plumbing", () => {
  it("resume refusals: a chat grant in the eval file, a non-4498 close", async () => {
    const c = sock.controller({ label: "agent", labelFlag: "renamed", node: "/w", agent: "z" });
    const a = c.resumeEval("tok1");
    const ws = last();
    expect(ws.url).toContain("label=renamed");
    expect(ws.url).toContain("&node=%2Fw&agent=z");
    ws.emit({ type: "pending" });
    ws.emit({ type: "approved", scope: "chat", until: 1 });
    await expect(a).rejects.toThrow("not eval");
    const b = c.resumeEval("tok1");
    last().shut(1006, "gone");
    await expect(b).rejects.toThrow("socket closed (1006 gone)");
  });

  it("pairing refusals: error, close, and --for without a chat grant", async () => {
    const c = sock.controller({ label: "agent" });
    const a = c.pair();
    last().emit({ type: "denied" });
    await expect(a).rejects.toThrow("denied");
    const b = c.pair();
    last().shut(4403);
    await expect(b).rejects.toThrow("socket closed (4403)");
    await expect(sock.controller({ label: "a", forEmail: "f@x.com" }).pair()).rejects.toThrow(
      "--for needs the chat grant",
    );
  });

  it("--for pairs with the chat grant; a preview's token is never saved", async () => {
    writeFileSync(CHAT, grantFileBody("chat1", Date.now() + HOUR));
    expect(sock.chatGrant()).toMatchObject({ token: "chat1" });
    const c = sock.controller({ label: "agent", forEmail: "f@x.com" });
    const p = c.pair();
    const ws = last();
    expect(ws.url).toContain("for=f%40x.com");
    ws.emit({ type: "pending", code: "beef" });
    ws.emit({ type: "approved", until: Date.now() + HOUR, scope: "eval", for: "f@x.com" });
    await p;
    expect(existsSync(EVAL)).toBe(false);
  });

  it("token files default to the main checkout's root, shared by every worktree", () => {
    const root = sock.mainRoot();
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(root).not.toContain(".claude/worktrees");
  });

  it("chatGrant falls back to the eval grant; saveTo and loadToken round-trip", () => {
    expect(sock.chatGrant()).toBeUndefined();
    sock.saveTo(EVAL, "ev1", Date.now() + HOUR);
    expect(sock.chatGrant()).toMatchObject({ token: "ev1" });
    sock.saveTo(CHAT, "ch1", Date.now() + HOUR);
    expect(sock.loadToken()).toBe("ch1");
  });

  it("run collects results, streams chunks, rejects on error, and times out", async () => {
    const ws = new FakeWS("x");
    const chunks: unknown[] = [];
    const r = sock.run(ws as unknown as WebSocket, "1+1", "iPhone", {
      onChunk: (m) => chunks.push(m),
    });
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "eval", code: "1+1", target: "iPhone" });
    ws.emit({ type: "sent", id: "e1", delivered: 1 });
    ws.emit({ type: "chunk", id: "e1", data: "x" });
    ws.emit({ type: "result", id: "e1", ok: true });
    expect(await r).toEqual([{ type: "result", id: "e1", ok: true }]);
    expect(chunks).toHaveLength(1);
    const bad = sock.run(ws as unknown as WebSocket, "x");
    ws.emit({ type: "error", error: "nope" });
    await expect(bad).rejects.toThrow("nope");
    const quiet = sock.run(ws as unknown as WebSocket, "x", undefined, { waitMs: 1 });
    expect(await quiet).toEqual([]);
  });
});
