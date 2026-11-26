import { describe, expect, it } from "bun:test";
import { SharedDictationRouter, type DictationPolicy } from "../lib/shared-dictation-router";
import type {
  DictationFinal,
  DictationHubMessage,
} from "../packages/debug-chat/src/dictation-wire";

const account = "account_a",
  bid = "browser_00000001",
  routeId = "window_001",
  origin = "https://example.com";
const permit = { origin, revision: 1 };
function fixture(overrides: Partial<DictationPolicy> = {}) {
  let now = 1_800_000_000_000;
  const policy = {
    leaseMs: 60_000,
    pendingMs: 600_000,
    maxQueued: 50,
    maxRoutes: 8,
    maxReceipts: 128,
    ...overrides,
  };
  const sent: { account: string; bid: string; source: string; event: DictationHubMessage }[] = [];
  const wake: string[] = [];
  const router = new SharedDictationRouter({
    now: () => now,
    policy: () => policy,
    send: (account, bid, source, event) => sent.push({ account, bid, source, event }),
    wake: (account, origin) => wake.push(account + " " + origin),
  });
  router.sourceOn(account, bid, "source_a", 1);
  router.route(account, origin, { op: "route", state: "on", bid, routeId }, permit, 2);
  const final = (finalId = "final_001"): DictationFinal => ({
    type: "chat-dictation",
    bid,
    routeId,
    gen: 2,
    sgen: 1,
    finalId,
    text: "synthetic input",
    at: now,
  });
  const read = (afterSeq?: number) =>
    router.read(
      account,
      origin,
      { bid, routeId, gen: 2, ...(afterSeq === undefined ? {} : { afterSeq }) },
      permit,
    );
  return {
    router,
    sent,
    wake,
    policy,
    final,
    read,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("shared dictation queue: synthetic text, no microphone or chat writes", () => {
  it("a scoped flag reset preserves other accounts while retiring the selected source and target", () => {
    const f = fixture();
    f.router.sourceOn("account_b", bid, "source_b", 3);
    f.router.route("account_b", origin, { op: "route", state: "on", bid, routeId }, permit, 4);
    f.router.disable(account);
    expect(f.router.source(account, bid)).toBeNull();
    expect(f.read()).toEqual({ ok: false, error: "stale" });
    expect(f.router.source("account_b", bid)?.id).toBe("source_b");
    expect(f.router.target("account_b", bid)?.gen).toBe(4);
    f.router.disable();
    expect(f.router.source("account_b", bid)).toBeNull();
    expect(f.router.target("account_b", bid)).toBeNull();
  });
  it("queues, redelivers after a lost response, and settles only after a bounded append ACK", () => {
    const f = fixture();
    f.router.final(account, "source_a", f.final(), permit);
    const first = f.read();
    expect(first).toMatchObject({
      ok: true,
      range: { throughSeq: 1, items: [{ seq: 1, finalId: "final_001", text: "synthetic input" }] },
    });
    expect(f.read()).toEqual(first);
    expect(f.sent.some((m) => m.event.type === "dictation-acked")).toBe(false);
    expect(f.read(2)).toEqual({ ok: false, error: "invalid" });
    expect(f.read()).toEqual(first);
    expect(f.read(1)).toMatchObject({ ok: true, range: { items: [] } });
    expect(f.sent.at(-1)?.event).toEqual({ type: "dictation-acked", finalIds: ["final_001"] });
    f.router.final(account, "source_a", f.final(), permit);
    expect(f.sent.at(-1)?.event.type).toBe("dictation-acked");
    expect(f.read(1)).toMatchObject({ ok: true, range: { items: [] } });
  });

  it("returns never-delivered input but only marks delivered input uncertain when a target ends", () => {
    const f = fixture();
    f.router.final(account, "source_a", f.final("final_read"), permit);
    f.read();
    f.router.final(account, "source_a", f.final("final_queue"), permit);
    f.router.route(
      account,
      "https://other.example",
      { op: "route", state: "on", bid, routeId: "window_002" },
      { origin: "https://other.example", revision: 1 },
      3,
    );
    expect(f.sent.filter((x) => x.event.type === "dictation-unconfirmed").at(-1)?.event).toEqual({
      type: "dictation-unconfirmed",
      finalIds: ["final_read"],
      why: "target-changed",
    });
    expect(f.sent.filter((x) => x.event.type === "dictation-returned").at(-1)?.event).toEqual({
      type: "dictation-returned",
      finalIds: ["final_queue"],
      why: "target-changed",
    });
    expect(f.read()).toEqual({ ok: false, error: "stale" });
  });

  it("a stale beat/off cannot reacquire or preempt a newer window", () => {
    const f = fixture();
    f.router.route(
      account,
      origin,
      { op: "route", state: "on", bid, routeId: "window_002" },
      permit,
      3,
    );
    for (const state of ["beat", "off"] as const)
      expect(
        f.router.route(account, origin, { op: "route", state, bid, routeId, gen: 2 }, permit),
      ).toEqual({ ok: true, kind: "route", state: "off", gen: 2 });
    expect(f.router.target(account, bid)?.routeId).toBe("window_002");
    expect(
      f.router.route(account, origin, { op: "route", state: "on", bid, routeId }, permit, 2),
    ).toEqual({ ok: false, error: "stale" });
  });

  it("isolates account, browser, origin, route id, generation and grant revision", () => {
    const f = fixture();
    f.router.final(account, "source_a", f.final(), permit);
    const sel = { bid, routeId, gen: 2 };
    for (const [who, site, selector, grant] of [
      ["account_b", origin, sel, permit],
      [account, origin, { ...sel, bid: "browser_00000002" }, permit],
      [account, "https://other.example", sel, permit],
      [account, origin, { ...sel, routeId: "window_002" }, permit],
      [account, origin, { ...sel, gen: 9 }, permit],
      [account, origin, sel, { ...permit, revision: 2 }],
    ] as const)
      expect(f.router.read(who, site, selector, grant)).toEqual({ ok: false, error: "stale" });
    expect(f.read()).toMatchObject({ ok: true, range: { items: [{ finalId: "final_001" }] } });
  });

  it("source takeover rejects stale senders and source disconnect drops only queued input", () => {
    const f = fixture();
    f.router.final(account, "source_a", f.final("final_read"), permit);
    f.read();
    f.router.final(account, "source_a", f.final("final_queue"), permit);
    f.router.sourceOff(account, "source_a", bid);
    expect(f.read()).toMatchObject({ ok: true, range: { items: [{ finalId: "final_read" }] } });
    expect(
      f.sent.find(
        (m) => m.event.type === "dictation-returned" && m.event.finalIds[0] === "final_queue",
      )?.event,
    ).toMatchObject({ why: "gone" });
    expect(f.router.sourceOn(account, bid, "source_b", 4)).toBe(true);
    expect(f.router.sourceOn(account, bid, "source_c", 3)).toBe(false);
    f.router.final(account, "source_a", f.final("stale_final"), permit);
    expect(f.sent.at(-1)?.event).toEqual({
      type: "dictation-unconfirmed",
      finalIds: ["stale_final"],
      why: "gone",
    });
    expect(f.sent.filter((m) => m.event.type === "dictation-source-ok").at(-1)?.event).toEqual({
      type: "dictation-source-ok",
      bid,
      sgen: 4,
      principal: account,
    });
  });

  it("revocation deletes pending text and cannot be undone by old reads or retries", () => {
    const f = fixture();
    f.router.final(account, "source_a", f.final(), permit);
    f.router.revoke(account, origin);
    expect(f.read()).toEqual({ ok: false, error: "stale" });
    f.router.final(account, "source_a", f.final(), null);
    expect(f.sent.at(-1)?.event).toMatchObject({ type: "dictation-returned", why: "revoked" });
    expect(f.router.target(account, bid)).toBeNull();
  });

  it("queue-full returns a final exactly once and never accepts a later retry of it", () => {
    const f = fixture({ maxQueued: 1 });
    f.router.final(account, "source_a", f.final(), permit);
    f.router.final(account, "source_a", f.final("final_full"), permit);
    expect(f.sent.at(-1)?.event).toEqual({
      type: "dictation-returned",
      finalIds: ["final_full"],
      why: "full",
    });
    f.read();
    f.read(1);
    f.router.final(account, "source_a", f.final("final_full"), permit);
    expect(f.read(1)).toMatchObject({ ok: true, range: { items: [] } });
    expect(f.sent.at(-1)?.event.type).toBe("dictation-returned");
  });

  it("retains replay receipts for a live generation and backpressures rather than evicting", () => {
    const f = fixture({ maxReceipts: 1 });
    f.router.final(account, "source_a", f.final(), permit);
    f.read();
    f.read(1);
    f.router.final(account, "source_a", f.final("final_second"), permit);
    expect(f.router.target(account, bid)).toBeNull();
    expect(f.sent.at(-1)?.event).toEqual({
      type: "dictation-returned",
      finalIds: ["final_second"],
      why: "full",
    });
    f.router.final(account, "source_a", f.final("final_second"), permit);
    expect(f.sent.at(-1)?.event.type).toBe("dictation-unconfirmed");
  });

  it("expires target leases independently of mic visibility and expires unacked items", () => {
    const f = fixture({ pendingMs: 1_000 });
    f.router.final(account, "source_a", f.final(), permit);
    expect(f.router.nextExpiry()).toBe(1_800_000_001_000);
    f.advance(1_001);
    f.router.sweep();
    expect(f.sent.at(-1)?.event).toEqual({
      type: "dictation-returned",
      finalIds: ["final_001"],
      why: "expired",
    });
    f.advance(60_000);
    f.router.sweep();
    expect(f.router.target(account, bid)).toBeNull();
    expect(f.sent.at(-1)?.event).toEqual({ type: "dictation-target", bid, target: null });
  });
});
