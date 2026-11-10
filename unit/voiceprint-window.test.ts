/**
 * Owner items of 2026-11-11 (docs/local-stt.md): the passkey window (one
 * Face ID covers every voiceprint op for `voiceprint.passkeyWindowMs`;
 * lib/voiceprint-approval.ts, lib/voiceprint-ticket.ts, webauthn.ts), "Test my
 * voiceprint" in the panel, and deleting the print never deleting the kept
 * recordings on the Mac (voiceprint.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { LocalFinal } from "@lianki/debug-chat/local-stt";
import {
  DEFAULT_BANDS,
  type EnrolDeps,
  bandFor,
  createEnrolment,
  testResult,
} from "@lianki/debug-chat/voiceprint";
import {
  endVoiceprintWindow,
  subscribeVoiceprintWindow,
  voiceprintTicket,
  voiceprintWindow,
} from "@lianki/debug-chat/webauthn";
import { CONFIG } from "@/lib/config";
import { fromB64url, importTicketKey } from "@/lib/stt-ticket";
import { type ApprovalDeps, voiceprintApproval } from "@/lib/voiceprint-approval";
import {
  GRANT_AUD,
  VOICEPRINT_TICKET_TTL_S,
  importTicketVerifyKey,
  openChallenge,
  openGrant,
  sessionTag,
} from "@/lib/voiceprint-ticket";

async function keys() {
  const p = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", p.privateKey);
  const raw = JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x });
  return { key: await importTicketKey(raw), pub: await importTicketVerifyKey(raw) };
}

const NOW = 1_800_000_000_000;
const WINDOW = 600_000;
const payload = (t: string) =>
  JSON.parse(new TextDecoder().decode(fromB64url(t.split(".")[0]!))) as Record<string, unknown>;

async function deps(o: Partial<ApprovalDeps> = {}) {
  const k = await keys();
  const used = new Set<string>();
  const d: ApprovalDeps = {
    key: k.key,
    pub: k.pub,
    userId: "owner-1",
    now: NOW,
    rp: { rpID: "lianki.com", origins: ["https://lianki.com"] },
    passkeys: async () => [
      { id: "pk0", credentialID: "Y3JlZDA", publicKey: "AAAA", counter: 4, transports: null },
    ],
    check: async () => ({ verified: true, userVerified: true, newCounter: 5 }),
    saveCounter: async () => {},
    consume: async (ch) => (used.has(ch) ? false : (used.add(ch), true)),
    windowMs: WINDOW,
    sid: await sessionTag("session-A"),
    ...o,
  };
  return d;
}

/** Face ID once: options, then verify, as the page does. */
async function approve(d: ApprovalDeps, op = "enrol", device = "iphone", client = "iphone") {
  const opt = await voiceprintApproval({ op, device, step: "options" }, d);
  return voiceprintApproval(
    { op, device, step: "verify", token: opt.json.token, response: { id: "Y3JlZDA" }, client },
    d,
  );
}
const mint = (d: ApprovalDeps, grant: unknown, b: Record<string, unknown> = {}) =>
  voiceprintApproval(
    { op: "delete", device: "*", step: "grant", grant, client: "iphone", ...b },
    d,
  );

describe("the passkey window: lianki.com", () => {
  it("the config key: 10 minutes by default, 0 turns it off, server only", () => {
    const c = CONFIG["voiceprint.passkeyWindowMs"];
    expect(c.default).toBe(600_000);
    expect(c.min).toBe(0);
    expect(c.audience).toBe("server");
  });

  it("one verified assertion gives the ticket and a grant for this account, session and device", async () => {
    const d = await deps();
    const r = await approve(d);
    expect(r.status).toBe(200);
    const g = payload(r.json.grant as string);
    expect(g).toMatchObject({ aud: GRANT_AUD, uid: "owner-1", client: "iphone", sid: d.sid });
    expect(g.exp).toBe(NOW / 1000 + WINDOW / 1000);
    expect(r.json.grantExp).toBe(g.exp);
    // The session id itself is never in it, only its tag.
    expect(JSON.stringify(g)).not.toContain("session-A");
  });

  it("inside the window, every voiceprint op gets a ticket with no prompt, each single use (its own jti)", async () => {
    const d = await deps();
    const { grant } = (await approve(d)).json;
    const jtis = new Set<string>();
    for (const [op, device] of [
      ["delete", "*"],
      ["delete-audio", "*"],
      ["export", "*"],
      ["restore", "*"],
      ["enrol", "iphone"],
      ["enrol", "android"], // re-compute: another device's recordings
    ] as const) {
      const r = await mint({ ...d, now: NOW + 60_000 }, grant, { op, device });
      expect(r.status).toBe(200);
      const p = payload(r.json.ticket as string);
      // Exactly what the Mac checks, as before: aud, op, device, uv; once by jti.
      expect(p).toMatchObject({ aud: "lianki-voiceprint", op, device, uv: true, uid: "owner-1" });
      expect((p.exp as number) - (p.iat as number)).toBeLessThanOrEqual(VOICEPRINT_TICKET_TTL_S);
      jtis.add(p.jti as string);
    }
    expect(jtis.size).toBe(6);
    // Asking twice for the same op gives two different single-use tickets.
    const a = payload((await mint(d, grant)).json.ticket as string);
    const b = payload((await mint(d, grant)).json.ticket as string);
    expect(a.jti).not.toBe(b.jti);
  });

  it("the window ends: after its exp, and early when the config is shortened or set to 0", async () => {
    const d = await deps();
    const { grant } = (await approve(d)).json;
    expect((await mint({ ...d, now: NOW + WINDOW - 30_000 }, grant)).status).toBe(200);
    expect((await mint({ ...d, now: NOW + WINDOW + 1_000 }, grant)).status).toBe(401);
    // A ticket never outlives the grant; too close to the end, it asks again.
    const late = await mint({ ...d, now: NOW + WINDOW - 30_000 }, grant);
    expect(payload(late.json.ticket as string).exp).toBeLessThanOrEqual(NOW / 1000 + WINDOW / 1000);
    expect((await mint({ ...d, now: NOW + WINDOW - 2_000 }, grant)).status).toBe(401);
    expect((await mint({ ...d, now: NOW + 120_000, windowMs: 60_000 }, grant)).status).toBe(401);
    expect((await mint({ ...d, windowMs: 0 }, grant)).status).toBe(401);
  });

  it("another account, session (signed out) or device is refused; so is an edited or foreign grant", async () => {
    const d = await deps();
    const { grant } = (await approve(d)).json;
    expect((await mint({ ...d, userId: "someone-else" }, grant)).status).toBe(401);
    expect((await mint({ ...d, sid: await sessionTag("session-B") }, grant)).status).toBe(401);
    expect((await mint({ ...d, sid: undefined }, grant)).status).toBe(401);
    expect((await mint(d, grant, { client: "android" })).status).toBe(401);
    expect((await mint(d, `x${grant}`)).status).toBe(401);
    expect((await mint(d, undefined)).status).toBe(401);
    const other = await deps();
    const foreign = (await approve(other)).json.grant;
    expect((await mint(d, foreign)).status).toBe(401);
    // status needs no grant, and a grant mints nothing but passkey ops.
    expect((await mint(d, grant, { op: "rename" })).status).toBe(400);
  });

  it("a grant is not a challenge or a ticket: it opens nothing else", async () => {
    const d = await deps();
    const { grant, ticket } = (await approve(d)).json;
    // As a challenge token (the verify step).
    expect(
      await openChallenge(String(grant), d.pub, {
        op: "delete",
        device: "*",
        uid: "owner-1",
        now: NOW,
      }),
    ).toBeNull();
    const r = await voiceprintApproval(
      { op: "delete", device: "*", step: "verify", token: grant, response: { id: "Y3JlZDA" } },
      d,
    );
    expect(r.status).toBe(401);
    // A ticket is not a grant.
    expect(
      await openGrant(String(ticket), d.pub, {
        uid: "owner-1",
        sid: d.sid!,
        client: "iphone",
        windowMs: WINDOW,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("no window: no grant (0, no session, or no device named), so every op prompts", async () => {
    for (const o of [{ windowMs: 0 }, { sid: undefined }]) {
      const r = await approve(await deps(o));
      expect(r.status).toBe(200);
      expect(r.json.grant).toBeUndefined();
    }
    const d = await deps();
    const opt = await voiceprintApproval({ op: "enrol", device: "iphone", step: "options" }, d);
    const r = await voiceprintApproval(
      {
        op: "enrol",
        device: "iphone",
        step: "verify",
        token: opt.json.token,
        response: { id: "Y3JlZDA" },
      },
      d,
    );
    expect(r.json.grant).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the page
/** lianki.com as the page sees it: the real approval behind a fetch. */
async function server(o: Partial<ApprovalDeps> = {}) {
  const d = await deps(o);
  let now = NOW;
  const calls: string[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.step ?? body.op);
    const r = await voiceprintApproval(body, { ...d, now });
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  let prompts = 0;
  const creds = {
    get: async () => {
      prompts++;
      const raw = new Uint8Array([1, 2, 3]).buffer;
      return {
        id: "Y3JlZDA",
        rawId: raw,
        type: "public-key",
        response: { clientDataJSON: raw, authenticatorData: raw, signature: raw },
        getClientExtensionResults: () => ({}),
      };
    },
  } as unknown as Pick<CredentialsContainer, "get">;
  const ask = (op: Parameters<typeof voiceprintTicket>[0], client = "iphone") =>
    voiceprintTicket(op, "*", { fetch: f, creds, client, now: () => now });
  return {
    d,
    ask,
    calls,
    prompts: () => prompts,
    at: (t: number) => void (now = t),
  };
}

afterEach(() => endVoiceprintWindow());

describe("the passkey window: the page", () => {
  it("no grant → the prompt; then no prompt for any op until the window ends", async () => {
    const s = await server();
    expect(voiceprintWindow(NOW)).toBeNull();
    await s.ask("delete");
    expect(s.prompts()).toBe(1);
    expect(voiceprintWindow(NOW)).toBe(NOW + WINDOW);
    for (const op of ["export", "restore", "delete-audio"] as const) await s.ask(op);
    expect(s.prompts()).toBe(1);
    expect(s.calls.filter((c) => c === "grant")).toHaveLength(3);
    // Past the window: the passkey again, which opens a new one.
    s.at(NOW + WINDOW + 1_000);
    await s.ask("delete");
    expect(s.prompts()).toBe(2);
  });

  it("a grant lianki.com refuses (signed out and in, config shortened) falls back to the prompt", async () => {
    const s = await server();
    await s.ask("delete");
    s.d.sid = await sessionTag("session-B"); // another sign-in session now
    await s.ask("export");
    expect(s.prompts()).toBe(2);
    expect(s.calls).toContain("grant");
    await s.ask("export"); // the new window, from the second prompt
    expect(s.prompts()).toBe(2);
    s.d.windowMs = 60_000; // shortened at /dev/config
    s.at(NOW + 120_000);
    await s.ask("restore");
    expect(s.prompts()).toBe(3);
  });

  it("bound to the device: another client slug prompts; status never needs one; End now ends it", async () => {
    const s = await server();
    await s.ask("status");
    expect(s.prompts()).toBe(0);
    await s.ask("delete");
    await s.ask("export", "android");
    expect(s.prompts()).toBe(2);
    endVoiceprintWindow();
    expect(voiceprintWindow(NOW)).toBeNull();
    await s.ask("export");
    expect(s.prompts()).toBe(3);
  });

  it("the panel hears the window open, end by time, and End now; a server error is not a prompt", async () => {
    const s = await server();
    let n = 0;
    const off = subscribeVoiceprintWindow(() => void n++);
    await s.ask("delete");
    expect(n).toBe(1); // opened
    expect(voiceprintWindow(NOW + WINDOW + 1)).toBeNull(); // ended by time
    expect(n).toBe(2);
    endVoiceprintWindow(); // nothing held: no event
    expect(n).toBe(2);
    await s.ask("delete");
    endVoiceprintWindow();
    expect(n).toBe(4);
    off();
    await s.ask("delete");
    expect(n).toBe(4);
    // A grant step that fails for another reason (lianki.com down) is an error, not a new prompt.
    const down = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(
      voiceprintTicket("export", "*", { fetch: down, client: "iphone", now: () => NOW }),
    ).rejects.toThrow("HTTP 503");
    expect(s.prompts()).toBe(3);
  });

  it("kept in memory only: nothing in storage", async () => {
    const s = await server();
    await s.ask("delete");
    const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
    for (const st of [g.localStorage, g.sessionStorage])
      if (st)
        for (let i = 0; i < st.length; i++)
          expect(st.getItem(st.key(i)!) ?? "").not.toContain(GRANT_AUD);
    expect(JSON.stringify(Object.keys(globalThis))).not.toContain("grant");
  });
});

// ---------------------------------------------------------------- the panel
const tick = () => new Promise((r) => setTimeout(r, 0));

function panel(o: { macRecordings?: number; bands?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const tickets: string[] = [];
  let onTest: ((f: Promise<LocalFinal> | null) => void) | null = null;
  const testCaptures: boolean[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: EnrolDeps = {
    device: "iphone",
    async request(m) {
      sent.push(m);
      if (m.op === "status")
        return {
          ok: true,
          prints: [{ device: "iphone", model: "campp", n: 20 }],
          filter: "on",
          ...(o.bands === false ? {} : { bands: DEFAULT_BANDS, recordings: o.macRecordings ?? 0 }),
        };
      if (m.op === "delete") return { ok: true, deleted: 1, recordings: o.macRecordings ?? 0 };
      if (m.op === "delete-audio") return { ok: true, deleted: o.macRecordings ?? 0 };
      return { ok: true };
    },
    async ticket(op, device) {
      tickets.push(`${op}:${device}`);
      return `T-${op}`;
    },
    capture() {},
    testCapture(on, f) {
      testCaptures.push(on);
      onTest = on ? f : null;
    },
    filterInfo: async (state) => ({
      flag: true,
      paused: false,
      state,
      tally: { day: "2026-11-11", n: 0, would: 0 },
    }),
    log: (ev) => void logs.push(ev),
  };
  const c = createEnrolment(deps, () => {});
  const say = async (f: Partial<LocalFinal> | null) => {
    onTest?.(
      f
        ? Promise.resolve({ text: "hello", model: "m", ms: 1, endToFinalMs: 1, ...f } as LocalFinal)
        : null,
    );
    await tick();
    await tick();
  };
  return { c, sent, tickets, testCaptures, say, logs, hasHook: () => !!onTest };
}

describe("Test my voiceprint", () => {
  it("each line shows at once the score, decision, speech seconds and SNR; a running tally", async () => {
    const h = panel();
    await h.c.open();
    await h.c.test();
    expect(h.testCaptures).toEqual([true]);
    expect(h.c.view()).toMatchObject({
      step: "test",
      listening: true,
      results: [],
      tally: { me: 0, other: 0, unknown: 0 },
    });
    await h.say({
      speaker: {
        decision: "me",
        score: 0.41,
        model: "campp",
        device: "iphone",
        speechS: 3.4,
        snrDb: 22.1,
      },
    });
    await h.say({
      speaker: {
        decision: "other",
        score: 0.05,
        model: "campp",
        device: "iphone",
        speechS: 2.2,
        snrDb: 18,
      },
      wouldFilter: "no-match",
    });
    await h.say({
      speaker: {
        decision: "unknown",
        reason: "short",
        model: "campp",
        device: "iphone",
        speechS: 0.8,
        snrDb: 15,
      },
    });
    await h.say(null); // the Mac unreachable
    const v = h.c.view();
    if (v.step !== "test") throw new Error(v.step);
    expect(v.tally).toEqual({ me: 1, other: 1, unknown: 1 });
    expect(v.results.map((r) => r.decision)).toEqual(["unreachable", "unknown", "other", "me"]);
    expect(v.results[2]).toMatchObject({ score: 0.05, speechS: 2.2, snrDb: 18, filtered: "would" });
    expect(v.filter).toMatchObject({ flag: true, state: "on" });
    // The thresholds used for each length.
    expect(bandFor(v.bands!.campp, 3.4)).toEqual({ minS: 3, me: 0.3, other: 0.2 });
    expect(bandFor(v.bands!.campp, 2.2)).toEqual({ minS: 1.5, me: 0.28, other: 0.18 });
    expect(bandFor(v.bands!.campp, 0.8)).toBeNull();
    // Never the text: neither the view nor the log has it.
    expect(JSON.stringify(v)).not.toContain("hello");
    expect(JSON.stringify(h.logs)).not.toContain("hello");
    // Done: the mic back to the chat, the status again.
    h.c.endTest();
    expect(h.testCaptures).toEqual([true, false]);
    await tick();
    expect(h.c.view().step).toBe("status");
  });

  it("closing the panel ends the test; an old Mac without bands gets the documented ones", async () => {
    const h = panel({ bands: false });
    await h.c.open();
    await h.c.test();
    const v = h.c.view();
    expect(v.step === "test" && v.bands).toEqual(DEFAULT_BANDS);
    h.c.close();
    expect(h.testCaptures).toEqual([true, false]);
    expect(h.hasHook()).toBe(false);
  });

  it("a filtered final reads as stopped; no speaker tag reads as unreachable", () => {
    expect(
      testResult({
        text: "",
        model: "m",
        ms: 1,
        endToFinalMs: 1,
        speaker: { decision: "other", score: 0.02 },
        filtered: { reason: "no-match", score: 0.02 },
      } as LocalFinal),
    ).toMatchObject({ decision: "other", filtered: "stopped" });
    expect(testResult({ text: "x", model: "m", ms: 1, endToFinalMs: 1 })).toEqual({
      decision: "unreachable",
    });
  });
});

describe("deleting the print never deletes the recordings on the Mac", () => {
  it("the print delete asks nothing of the recordings; they are offered separately, kept by default", async () => {
    const h = panel({ macRecordings: 12 });
    await h.c.open();
    h.c.askDelete();
    await h.c.confirmDelete();
    expect(h.sent.filter((m) => m.op === "delete")).toEqual([
      { t: "voiceprint", op: "delete", device: "*", ticket: "T-delete" },
    ]);
    expect(h.sent.some((m) => m.op === "delete-audio")).toBe(false);
    expect(h.c.view()).toMatchObject({ step: "deleted", mac: { n: 12, state: "offer" } });
    h.c.keepMacRecordings();
    expect(h.c.view()).toMatchObject({ mac: { n: 12, state: "kept" } });
    await h.c.deleteMacRecordings(); // kept: the question is gone, nothing is sent
    expect(h.sent.some((m) => m.op === "delete-audio")).toBe(false);
  });

  it("only the extra tap deletes them, with its own delete-audio ticket", async () => {
    const h = panel({ macRecordings: 12 });
    await h.c.open();
    h.c.askDelete();
    await h.c.confirmDelete();
    await h.c.deleteMacRecordings();
    expect(h.tickets.at(-1)).toBe("delete-audio:*");
    expect(h.sent.at(-1)).toEqual({
      t: "voiceprint",
      op: "delete-audio",
      device: "*",
      ticket: "T-delete-audio",
    });
    expect(h.c.view()).toMatchObject({ mac: { n: 12, state: "done" } });
  });

  it("nothing kept on the Mac: no question", async () => {
    const h = panel({ macRecordings: 0 });
    await h.c.open();
    h.c.askDelete();
    await h.c.confirmDelete();
    expect(h.c.view()).toEqual({ step: "deleted", files: 1 });
  });
});
