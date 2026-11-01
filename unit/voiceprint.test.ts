/**
 * The voiceprint, the page's side (packages/debug-chat/src/voiceprint.ts;
 * docs/local-stt.md, "Voiceprint"): consent gating and delete in the
 * enrolment card, the speaker tag on voice lines, the mic routing enrolment
 * sentences to the Mac only, "other" dropped in passive mode, and the local
 * STT socket's part of the protocol. The server's side (scoring, thresholds,
 * the store's file modes) is unit/local-stt-voiceprint.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { type LocalFinal, type WsLike, createLocalStt } from "@lianki/debug-chat/local-stt";
import { type EnrolTap, RATE, type StreamStt, createMic } from "@lianki/debug-chat/mic";
import {
  ENROL_MAX,
  ENROL_MIN,
  ENROL_SENTENCES,
  type EnrolDeps,
  type EnrolView,
  clearSpeaker,
  createEnrolment,
  deviceSlug,
  matchesPrompt,
  noteSpeaker,
  takeSpeaker,
} from "@lianki/debug-chat/voiceprint";
import { type SpeakerTag, cleanSpeaker, combineSpeaker } from "@lianki/debug-chat/wire";
import { CHAT_STRINGS_EN } from "@lianki/debug-chat/wire";
import { parsePageMessage } from "@/lib/dev-eval";

const tick = () => new Promise((r) => setTimeout(r, 0));
const me = (score = 0.6): SpeakerTag => ({
  decision: "me",
  score,
  model: "campp",
  device: "iphone",
});
const other = (score = 0.05): SpeakerTag => ({
  decision: "other",
  score,
  model: "campp",
  device: "iphone",
});

describe("wire: the speaker tag", () => {
  it("cleanSpeaker keeps known keys, checked, and drops anything else", () => {
    expect(
      cleanSpeaker({
        decision: "me",
        score: 0.41234,
        model: "campp",
        device: "iphone",
        speechS: 2.345,
        snrDb: 18.27,
        x: 1,
      }),
    ).toEqual({
      decision: "me",
      score: 0.412,
      model: "campp",
      device: "iphone",
      speechS: 2.35,
      snrDb: 18.3,
    });
    expect(cleanSpeaker({ decision: "yes" })).toBeUndefined();
    expect(cleanSpeaker({ score: 0.9 })).toBeUndefined();
    expect(cleanSpeaker("me")).toBeUndefined();
    expect(
      cleanSpeaker({ decision: "unknown", score: 7, device: "../x", reason: "no-print" }),
    ).toEqual({
      decision: "unknown",
      reason: "no-print",
    });
  });

  it("combineSpeaker: the weakest decision and the lowest score win", () => {
    expect(combineSpeaker([])).toBeUndefined();
    expect(combineSpeaker([undefined])).toBeUndefined();
    expect(combineSpeaker([me(0.5), me(0.7)])).toMatchObject({ decision: "me", score: 0.5 });
    expect(combineSpeaker([me(0.5), { decision: "unknown", reason: "short" }])).toMatchObject({
      decision: "unknown",
      score: 0.5,
    });
    expect(combineSpeaker([me(0.5), other(0.1), { decision: "unknown" }])).toMatchObject({
      decision: "other",
      score: 0.1,
    });
  });

  it("noteSpeaker / takeSpeaker: per line, with the Mac's proofs; untagged makes it unknown", () => {
    clearSpeaker();
    expect(takeSpeaker()).toEqual({});
    noteSpeaker(me(0.6), "p1");
    noteSpeaker(me(0.4), "p2");
    expect(takeSpeaker()).toMatchObject({
      tag: { decision: "me", score: 0.4 },
      proofs: ["p1", "p2"],
    });
    expect(takeSpeaker()).toEqual({}); // taken
    noteSpeaker(me(), "p3");
    noteSpeaker(undefined); // went to the cloud: no proof for the line at all
    const t = takeSpeaker();
    expect(t.tag).toMatchObject({ decision: "unknown", reason: "untagged" });
    expect(t.proofs).toBeUndefined();
    noteSpeaker(undefined);
    expect(takeSpeaker()).toEqual({});
    noteSpeaker(other(), "p4");
    clearSpeaker();
    expect(takeSpeaker()).toEqual({});
  });

  it("the hub's parser keeps only the Mac's proofs on voice lines, never a page's tag", () => {
    const v = parsePageMessage(
      JSON.stringify({
        type: "chat",
        id: "a",
        text: "hi",
        source: "stt",
        speaker: me(),
        speakerProof: ["a.b", 3, "c.d"],
      }),
    ) as { speaker?: unknown; speakerProof?: string[] };
    expect(v.speaker).toBeUndefined();
    expect(v.speakerProof).toEqual(["a.b", "c.d"]);
    const typed = parsePageMessage(
      JSON.stringify({ type: "chat", id: "b", text: "hi", speakerProof: ["a.b"] }),
    ) as { speakerProof?: unknown };
    expect(typed.speakerProof).toBeUndefined();
  });
});

describe("deviceSlug and matchesPrompt", () => {
  it("one slug per kind of device; a valid override wins", () => {
    expect(deviceSlug("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iphone");
    expect(deviceSlug("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("android");
    expect(deviceSlug("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    expect(deviceSlug("curl/8")).toBe("other");
    expect(deviceSlug("…iPhone…", "pixel-9")).toBe("pixel-9");
    expect(deviceSlug("Mozilla/5.0 (iPhone)", "../etc")).toBe("iphone");
  });

  it("the heard text is the sentence when half its letters are there, in order", () => {
    const s = ENROL_SENTENCES[0]!;
    expect(matchesPrompt(s, s)).toBe(true);
    expect(matchesPrompt("今天的天汽不错我想出去走走", s)).toBe(true); // a homophone and a dropped word
    expect(matchesPrompt("你好。", s)).toBe(false);
    expect(matchesPrompt("", s)).toBe(false);
    expect(
      matchesPrompt(
        "The library is open until nine",
        "The library is open until nine o'clock in the evening.",
      ),
    ).toBe(true);
  });

  it("10-20 sentences, in his three languages", () => {
    expect(ENROL_SENTENCES.length).toBe(ENROL_MAX);
    expect(ENROL_MIN).toBe(10);
    expect(ENROL_SENTENCES.some((s) => /[぀-ヿ]/.test(s))).toBe(true);
    expect(ENROL_SENTENCES.some((s) => /^[A-Z]/.test(s))).toBe(true);
  });
});

/** The card with a fake Mac and a fake mic. */
function card(o: { local?: boolean; startOk?: boolean; passkey?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const tickets: string[] = [];
  const captures: boolean[] = [];
  let onFinal: ((f: Promise<LocalFinal> | null) => void) | null = null;
  let kept = 0;
  const views: EnrolView[] = [];
  const deps: EnrolDeps = {
    device: "iphone",
    async request(m) {
      sent.push(m);
      if (o.local === false) throw new Error("local stt not connected");
      if (m.t === "voiceprint" && m.op === "status") return { ok: true, prints: [] };
      if (m.t === "enrol" && m.op === "start")
        return o.startOk === false
          ? { ok: false, error: "ticket bad signature" }
          : { ok: true, enrolment: "E1" };
      if (m.t === "enrol" && m.op === "commit") return { ok: true, n: kept };
      if (m.t === "voiceprint" && m.op === "delete") return { ok: true, deleted: 2 };
      return { ok: true };
    },
    async ticket(op, device) {
      tickets.push(`${op}:${device}`);
      // enrol and delete stand for the owner's Face ID / Touch ID.
      if (op !== "status" && o.passkey === false) throw new Error("passkey cancelled");
      return `T-${op}`;
    },
    capture(on, f, id) {
      captures.push(on);
      if (on) expect(id).toBe("E1");
      onFinal = on ? f : null;
    },
  };
  const c = createEnrolment(deps, (v) => views.push(v));
  /** The Mac's answer to one sentence. */
  const sentence = async (text: string, ok = true, reason?: string) => {
    if (ok) kept++;
    onFinal?.(
      Promise.resolve({
        text,
        model: "local:sv",
        ms: 1,
        endToFinalMs: 1,
        enrol: { ok, n: kept, ...(reason ? { reason } : {}) },
      }),
    );
    await tick();
  };
  return { c, sent, captures, tickets, views, sentence, hasHook: () => !!onFinal };
}

describe("the enrolment card: consent first", () => {
  it("nothing is captured or started on the Mac before the consent tap", async () => {
    const h = card();
    await h.c.open();
    expect(h.c.view()).toEqual({ step: "status", prints: [], local: true });
    h.c.enrol();
    expect(h.c.view()).toEqual({ step: "consent", keepAudio: false });
    // Still nothing: only status was asked, and the mic was never routed.
    expect(h.sent.map((m) => `${m.t}:${m.op}`)).toEqual(["voiceprint:status"]);
    expect(h.captures).toEqual([]);
    // The steps after consent cannot be reached without it.
    h.c.save();
    h.c.skip();
    expect(h.c.view().step).toBe("consent");
    h.c.keepAudio(true);
    await h.c.consent();
    // The tap asked for the owner's passkey first; the start carries that ticket.
    expect(h.tickets).toEqual(["status:*", "enrol:iphone"]);
    expect(h.sent[0]).toMatchObject({ t: "voiceprint", op: "status", ticket: "T-status" });
    expect(h.sent[1]).toEqual({
      t: "enrol",
      op: "start",
      device: "iphone",
      consent: true,
      keepAudio: true,
      ticket: "T-enrol",
    });
    expect(h.captures).toEqual([true]);
    expect(h.c.view()).toEqual({ step: "recording", index: 0, kept: 0 });
  });

  it("consent() outside the consent card does nothing", async () => {
    const h = card();
    await h.c.consent();
    await h.c.open();
    await h.c.consent();
    expect(h.sent.map((m) => m.op)).toEqual(["status"]);
    expect(h.captures).toEqual([]);
  });

  it("the Mac refusing the start: an error, and the mic is never routed", async () => {
    const h = card({ startOk: false });
    await h.c.open();
    h.c.enrol();
    await h.c.consent();
    expect(h.c.view()).toMatchObject({ step: "error", error: "ticket bad signature" });
    expect(h.captures).toEqual([false]);
  });

  it("no passkey (cancelled, or none): no ticket, nothing sent to the Mac, nothing captured", async () => {
    const h = card({ passkey: false });
    await h.c.open();
    h.c.enrol();
    await h.c.consent();
    expect(h.c.view()).toMatchObject({ step: "error", error: "passkey cancelled" });
    expect(h.sent.map((m) => m.op)).toEqual(["status"]);
    expect(h.captures).toEqual([false]);
  });

  it("no local STT: status says so, and Enrol is not offered", async () => {
    const h = card({ local: false });
    await h.c.open();
    expect(h.c.view()).toEqual({ step: "status", prints: [], local: false });
    h.c.enrol();
    expect(h.c.view().step).toBe("status");
  });
});

describe("the enrolment card: reading", () => {
  const started = async () => {
    const h = card();
    await h.c.open();
    h.c.enrol();
    await h.c.consent();
    return h;
  };

  it("a kept sentence moves on; a rejected one asks again with the reason", async () => {
    const h = await started();
    await h.sentence(ENROL_SENTENCES[0]!);
    expect(h.c.view()).toMatchObject({ step: "recording", index: 1, kept: 1 });
    await h.sentence("x", false, "noise");
    expect(h.c.view()).toMatchObject({ step: "recording", index: 1, kept: 1, again: "noise" });
    await h.sentence("x", false, "short");
    expect(h.c.view()).toMatchObject({ again: "short" });
    await h.sentence("x", false, "mismatch");
    expect(h.c.view()).toMatchObject({ again: "mismatch" });
    // Kept by the Mac but not this sentence: asked once more, then on.
    await h.sentence("完全不一样的话");
    expect(h.c.view()).toMatchObject({ index: 1, kept: 2, again: "text" });
    await h.sentence("又不一样");
    expect(h.c.view()).toMatchObject({ index: 2, kept: 3 });
    // The Mac not reachable for one sentence.
    const hook = h.hasHook();
    expect(hook).toBe(true);
  });

  it("save from ENROL_MIN on; it stops the capture and commits", async () => {
    const h = await started();
    for (let i = 0; i < ENROL_MIN - 1; i++) await h.sentence(ENROL_SENTENCES[i]!);
    h.c.save();
    expect(h.c.view()).toMatchObject({ step: "recording", kept: ENROL_MIN - 1 });
    await h.sentence(ENROL_SENTENCES[ENROL_MIN - 1]!);
    h.c.save();
    await tick();
    expect(h.sent.at(-1)).toEqual({ t: "enrol", op: "commit", enrolment: "E1" });
    expect(h.captures).toEqual([true, false]);
    expect(h.c.view()).toEqual({ step: "saved", kept: ENROL_MIN });
  });

  it("saves by itself once ENROL_MAX sentences are kept", async () => {
    const h = await started();
    for (let i = 0; i < ENROL_MAX; i++) await h.sentence(ENROL_SENTENCES[i]!);
    await tick();
    expect(h.c.view()).toEqual({ step: "saved", kept: ENROL_MAX });
  });

  it("closing mid-way cancels on the Mac (nothing saved) and gives the mic back", async () => {
    const h = await started();
    await h.sentence(ENROL_SENTENCES[0]!);
    h.c.close();
    await tick();
    expect(h.sent.at(-1)).toEqual({ t: "enrol", op: "cancel", enrolment: "E1" });
    expect(h.captures).toEqual([true, false]);
    expect(h.sent.some((m) => m.op === "commit")).toBe(false);
    // A late answer for the closed run changes nothing.
    await h.sentence(ENROL_SENTENCES[1]!);
    expect(h.c.view()).toEqual({ step: "closed" });
  });
});

describe("the delete control", () => {
  it("needs the confirming tap, deletes every device's print, and says so", async () => {
    const h = card();
    await h.c.open();
    await h.c.confirmDelete(); // not asked yet: nothing
    expect(h.sent.some((m) => m.op === "delete")).toBe(false);
    h.c.askDelete();
    expect(h.c.view()).toEqual({ step: "confirm-delete" });
    expect(h.sent.some((m) => m.op === "delete")).toBe(false);
    await h.c.confirmDelete();
    expect(h.tickets.at(-1)).toBe("delete:*");
    expect(h.sent.at(-1)).toEqual({
      t: "voiceprint",
      op: "delete",
      device: "*",
      ticket: "T-delete",
    });
    expect(h.c.view()).toEqual({ step: "deleted", files: 2 });
  });

  it("delete without the passkey sends nothing", async () => {
    const h = card({ passkey: false });
    await h.c.open();
    h.c.askDelete();
    await h.c.confirmDelete();
    expect(h.sent.some((m) => m.op === "delete")).toBe(false);
    expect(h.c.view()).toMatchObject({ step: "error" });
  });

  it("every string the panel shows has an English default", () => {
    for (const k of Object.keys(CHAT_STRINGS_EN).filter((k) => k.startsWith("vp")))
      expect((CHAT_STRINGS_EN as Record<string, string>)[k]!.length).toBeGreaterThan(1);
    expect(CHAT_STRINGS_EN.vpConsent).toContain("~/.config/lianki-stt/voiceprints");
  });
});

// ---------------------------------------------------------------- the mic
type Up = { samples: number; local?: Promise<LocalFinal>; resolve: (t: string) => void };

/** A local STT whose finals the test answers (as the Mac would). */
function mac(connected = true) {
  const log: string[] = [];
  const finals: ((f: Partial<LocalFinal>) => void)[] = [];
  const stt: StreamStt = {
    connected: () => connected,
    begin(_p, opts) {
      if (!connected) return null;
      log.push(opts?.enrol ? "begin enrol" : "begin");
      return {
        frame: () => {},
        end: (audio, eo) => {
          log.push(
            `end ${audio.length}${eo?.textFrom !== undefined ? ` from ${eo.textFrom}` : ""}`,
          );
          return new Promise<LocalFinal>((resolve) =>
            finals.push((f) =>
              resolve({ text: "", model: "local:sv", ms: 1, endToFinalMs: 1, ...f }),
            ),
          );
        },
        cancel: () => void log.push("cancel"),
      };
    },
  };
  return { stt, log, answer: (f: Partial<LocalFinal>) => finals.shift()?.(f) };
}

function micWith(o: {
  stream?: StreamStt;
  enrol?: EnrolTap;
  passive?: () => boolean;
  spot?: (
    a: Float32Array,
  ) =>
    | Promise<never>
    | Promise<{ hit: boolean; rest: Float32Array; tokens: string[] } | { hit: false }>;
}) {
  let ev: Parameters<Parameters<typeof createMic>[0]["load"]>[0] | null = null;
  const uploads: Up[] = [];
  const texts: string[] = [];
  const tags: (SpeakerTag | undefined)[] = [];
  const verdicts: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let woke = 0;
  const mic = createMic({
    load: async (e) => {
      ev = e;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: (wav, info) =>
      new Promise((resolve) =>
        uploads.push({ samples: (wav.length - 44) / 2, local: info.local, resolve }),
      ),
    onState: () => {},
    onText: (t) => texts.push(t),
    onPending: () => {},
    stream: o.stream ? () => o.stream : undefined,
    enrol: o.enrol,
    speaker: (t) => tags.push(t),
    log: (e) => logs.push(e),
    wake: o.passive
      ? {
          passive: o.passive,
          spot: o.spot as never,
          onWake: () => void woke++,
          verdict: (ok, why) => void verdicts.push(`${ok} ${why}`),
        }
      : undefined,
  });
  const say = (sec: number) => {
    ev!.onSpeechStart();
    ev!.onSpeechEnd(new Float32Array(Math.round(sec * RATE)));
  };
  return { mic, say, uploads, texts, tags, verdicts, logs, woke: () => woke };
}

describe("the mic and enrolment", () => {
  it("while enrolling, a sentence goes to the Mac as enrolment only: no upload, no draft", async () => {
    const m = mac();
    const done: (Promise<LocalFinal> | null)[] = [];
    let on = true;
    const h = micWith({
      stream: m.stt,
      enrol: {
        active: () => on,
        begin: (cb) => m.stt.begin(cb, { enrol: "E1" }),
        done: (f) => void done.push(f),
      },
    });
    await h.mic.toggle();
    h.say(3);
    expect(m.log).toEqual(["begin enrol", `end ${RATE * 3}`]);
    expect(done).toHaveLength(1);
    m.answer({ text: "今天的天气不错", enrol: { ok: true, n: 1 } });
    expect((await done[0])?.enrol).toEqual({ ok: true, n: 1 });
    await tick();
    expect(h.uploads).toEqual([]);
    expect(h.texts).toEqual([]);
    expect(h.tags).toEqual([]);
    // Enrolment over: back to the chat as before.
    on = false;
    h.say(2);
    expect(m.log.at(-2)).toBe("begin");
    expect(h.uploads).toHaveLength(1);
  });

  it("the Mac not reachable while enrolling: done(null), and nothing goes to the cloud", async () => {
    const m = mac(false);
    const done: (Promise<LocalFinal> | null)[] = [];
    const h = micWith({
      stream: m.stt,
      enrol: {
        active: () => true,
        begin: (cb) => m.stt.begin(cb, { enrol: "E1" }),
        done: (f) => void done.push(f),
      },
    });
    await h.mic.toggle();
    h.say(4); // long enough for rolling cloud partials, were they allowed
    expect(done).toEqual([null]);
    expect(h.uploads).toEqual([]);
  });
});

describe("the mic and the speaker check", () => {
  it("active: each kept final's tag is noted; an 'other' counts as a rejection", async () => {
    const m = mac();
    const h = micWith({ stream: m.stt, passive: () => false, spot: async () => ({ hit: false }) });
    await h.mic.toggle();
    h.say(2);
    m.answer({ text: "你好", speaker: me() });
    await tick();
    h.uploads[0]!.resolve("你好");
    await tick();
    await tick();
    expect(h.tags).toEqual([me()]);
    expect(h.verdicts).toEqual(["true ok"]);
    h.say(2);
    m.answer({ text: "电视里的声音", speaker: other() });
    await tick();
    h.uploads[1]!.resolve("电视里的声音");
    await tick();
    await tick();
    // Active mode passes it on (never dropped there), but it counts towards passive.
    expect(h.texts.join("")).toContain("电视里的声音");
    expect(h.verdicts.at(-1)).toBe("false other");
  });

  it("passive: someone else's 'Linky' is dropped and wakes nothing (logged as a count)", async () => {
    const m = mac();
    const h = micWith({
      stream: m.stt,
      passive: () => true,
      spot: async (a) => ({ hit: true, rest: a.subarray(RATE), tokens: ["L"] }),
    });
    await h.mic.toggle();
    h.say(3);
    await tick();
    expect(m.log).toEqual(["begin", `end ${RATE * 3} from ${RATE}`]);
    m.answer({ text: "下一个", speaker: other() });
    await tick();
    await tick();
    expect(h.woke()).toBe(0);
    expect(h.uploads).toEqual([]);
    expect(h.texts).toEqual([]);
    const ev = h.logs.find((e) => e.ev === "speaker-other");
    expect(ev).toEqual({ ev: "speaker-other", mode: "passive", n: 1, score: 0.05, model: "campp" });
    expect(JSON.stringify(h.logs)).not.toContain("下一个"); // counts only, never the text
  });

  it("passive: his own 'Linky' (or unknown) wakes it, and the Mac's text is used", async () => {
    for (const tag of [me(), { decision: "unknown", reason: "short" } as SpeakerTag]) {
      const m = mac();
      const h = micWith({
        stream: m.stt,
        passive: () => true,
        spot: async (a) => ({ hit: true, rest: a.subarray(RATE), tokens: ["L"] }),
      });
      await h.mic.toggle();
      h.say(3);
      await tick();
      m.answer({ text: "下一个", speaker: tag });
      await tick();
      await tick();
      expect(h.woke()).toBe(1);
      expect(h.uploads).toHaveLength(1);
      expect(h.uploads[0]!.samples).toBe(RATE * 2); // the cloud fallback would get the words after Linky
      expect((await h.uploads[0]!.local)?.speaker).toEqual(tag);
    }
  });

  it("passive with no Mac: as before (wake, the rest to the cloud)", async () => {
    const h = micWith({
      passive: () => true,
      spot: async (a) => ({ hit: true, rest: a.subarray(RATE), tokens: ["L"] }),
    });
    await h.mic.toggle();
    h.say(3);
    await tick();
    await tick();
    expect(h.woke()).toBe(1);
    expect(h.uploads[0]!.local).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the socket
function sock() {
  const socks: (WsLike & { sent: (string | Uint8Array)[]; say: (m: object) => void })[] = [];
  const open = () => {
    const s = {
      readyState: 0,
      binaryType: "blob",
      sent: [] as (string | Uint8Array)[],
      send(d: string | Uint8Array) {
        s.sent.push(d);
      },
      close() {
        s.readyState = 3;
        s.onclose?.({});
      },
      onopen: null as WsLike["onopen"],
      onclose: null as WsLike["onclose"],
      onerror: null as WsLike["onerror"],
      onmessage: null as WsLike["onmessage"],
      say(m: object) {
        s.onmessage?.({ data: JSON.stringify(m) });
      },
    };
    socks.push(s);
    return s;
  };
  return { socks, open };
}
const json = (x: string | Uint8Array) => JSON.parse(x as string);

describe("createLocalStt: the voiceprint protocol", () => {
  const setup = () => {
    const w = sock();
    const stt = createLocalStt("wss://mac.ts.net/lianki-stt", { open: w.open, device: "iphone" });
    stt.warm();
    const s = w.socks[0]!;
    s.readyState = 1;
    s.say({ t: "ready", engine: "sensevoice", model: "m", speaker: { models: ["campp"] } });
    return { w, s, stt };
  };

  it("says which device it is, and what the Mac can check", () => {
    const { s, stt } = setup();
    expect(json(s.sent[0]!)).toEqual({ t: "hello", device: "iphone" });
    expect(stt.speaker()).toEqual(["campp"]);
  });

  it("an enrolment sentence is flagged; textFrom rides on the end; the tag comes back cleaned", async () => {
    const { s, stt } = setup();
    const u = stt.begin(() => {}, { enrol: "E1" })!;
    expect(json(s.sent[1]!)).toEqual({ t: "begin", id: 1, enrol: "E1" });
    const e = u.end(new Float32Array(10));
    s.say({ t: "final", id: 1, text: "x", enrol: { ok: false, n: 3, reason: "noise", extra: 1 } });
    expect((await e).enrol).toEqual({ ok: false, n: 3, reason: "noise" });
    const v = stt.begin(() => {})!;
    const f = v.end(new Float32Array(RATE * 2), { textFrom: RATE });
    expect(json(s.sent.at(-1)!)).toEqual({ t: "end", id: 2, textFrom: RATE });
    s.say({
      t: "final",
      id: 2,
      text: "下一个",
      speaker: { decision: "me", score: 0.512, model: "campp", device: "iphone", bogus: true },
      speakerProof: "PAYLOAD.SIG",
    });
    const got = await f;
    expect(got.proof).toBe("PAYLOAD.SIG");
    expect(got.speaker).toEqual({
      decision: "me",
      score: 0.512,
      model: "campp",
      device: "iphone",
    });
  });

  it("request: answered by its rid; rejected when the socket drops", async () => {
    const { s, stt } = setup();
    const p = stt.request({ t: "voiceprint", op: "status" });
    await tick();
    const sentReq = json(s.sent.at(-1)!);
    expect(sentReq).toMatchObject({ t: "voiceprint", op: "status" });
    s.say({ t: "voiceprint", rid: "nope", ok: true });
    s.say({ t: "voiceprint", rid: sentReq.rid, ok: true, prints: [] });
    expect(await p).toMatchObject({ ok: true, prints: [] });
    const q = stt.request({ t: "enrol", op: "commit" });
    await tick();
    s.close();
    await expect(q).rejects.toThrow();
  });

  it("request before the socket is open: it connects first", async () => {
    const w = sock();
    const stt = createLocalStt("wss://mac.ts.net/lianki-stt", { open: w.open });
    const p = stt.request({ t: "voiceprint", op: "status" });
    await tick();
    const s = w.socks[0]!;
    s.readyState = 1;
    s.say({ t: "ready", engine: "sensevoice", model: "m" });
    await tick();
    const r = json(s.sent.at(-1)!);
    s.say({ t: "voiceprint", rid: r.rid, ok: false, error: "speaker check off" });
    expect(await p).toMatchObject({ ok: false, error: "speaker check off" });
    expect(stt.speaker()).toBeUndefined(); // that server has no check
  });
});
