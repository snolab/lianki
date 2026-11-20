/**
 * Our own TTS voices, the page's side (docs/echo-suppression.md, layer (c), M4):
 * the "self" speaker decision on the wire, how it combines with his own
 * utterances, the switch the page reads from /api/dev/voice-filter (flag
 * stt.self-voice with stt.selfAccept / stt.selfMargin), and the selfVoice frame
 * the socket sends the Mac. The Mac's side is scripts/local-stt/test_voiceprint.py
 * (SelfVoice); the hub's verdict is unit/echo-reports.test.ts and
 * unit/debug-hub-echo-reports.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  type LocalFinal,
  type WsLike,
  createLocalStt,
  selfVoiceFrame,
} from "@lianki/debug-chat/local-stt";
import {
  FILTER_FLAG_TTL_MS,
  filterFlag,
  selfVoiceFlag,
  selfVoiceSwitch,
  testResult,
  voiceSwitches,
} from "@lianki/debug-chat/voiceprint";
import { type SpeakerTag, cleanSpeaker, combineSpeaker } from "@lianki/debug-chat/wire";

const tick = () => new Promise((r) => setTimeout(r, 0));
const self = (o: Partial<SpeakerTag> = {}): SpeakerTag => ({
  decision: "self",
  score: 0.1,
  selfScore: 0.72,
  selfVoice: "melo-en",
  model: "campp",
  device: "mac",
  ...o,
});
const me = (score = 0.6): SpeakerTag => ({ decision: "me", score, model: "campp", device: "mac" });

describe("wire: the self decision", () => {
  it("cleanSpeaker takes self with its score and our voice id, checked", () => {
    expect(cleanSpeaker({ ...self(), extra: 1 })).toEqual(self());
    // A voice id only on "self", only our slug form.
    expect(cleanSpeaker({ ...me(), selfVoice: "melo-en", selfScore: 0.2 })).toEqual({
      ...me(),
      selfScore: 0.2,
    });
    expect(cleanSpeaker({ ...self(), selfVoice: "Not A Slug" })).not.toHaveProperty("selfVoice");
    expect(cleanSpeaker({ ...self(), selfScore: 3 })).not.toHaveProperty("selfScore");
    expect(cleanSpeaker({ decision: "selfish" })).toBeUndefined();
  });

  it("a line all ours is self; next to his own words it is unknown, never folding him away", () => {
    expect(combineSpeaker([self(), self({ selfScore: 0.6 })])?.decision).toBe("self");
    expect(combineSpeaker([self(), { decision: "unknown", reason: "short" }])?.decision).toBe(
      "self",
    );
    expect(combineSpeaker([self(), { decision: "other", score: 0.05 }])?.decision).toBe("self");
    const mixed = combineSpeaker([me(), self()])!;
    expect(mixed.decision).toBe("unknown");
    expect(mixed.reason).toBe("self-mixed");
    expect(mixed).not.toHaveProperty("selfVoice");
    expect(combineSpeaker([me(), me(0.5)])?.decision).toBe("me");
  });

  it("the voiceprint test panel shows our voice as another voice, reason self", () => {
    const f = { text: "", model: "local:m", speaker: self() } as unknown as LocalFinal;
    expect(testResult(f)).toMatchObject({ decision: "other", reason: "self", score: 0.1 });
  });
});

describe("the self-voice switch", () => {
  const ans = (r: unknown) => (async () => r) as unknown as typeof fetch;

  it("reads stt.self-voice and its lines from the owner route; anything else is off", async () => {
    const ok = ans({
      ok: true,
      json: async () => ({ on: false, selfVoice: { on: true, accept: 0.5, margin: 0.2 } }),
    });
    expect(await selfVoiceFlag(ok)).toEqual({ on: true, accept: 0.5, margin: 0.2 });
    expect(await filterFlag(ok)).toBe(false);
    expect(
      await selfVoiceFlag(
        ans({ ok: true, json: async () => ({ on: true, selfVoice: { on: true, accept: "x" } }) }),
      ),
    ).toEqual({ on: true });
    expect(await selfVoiceFlag(ans({ ok: true, json: async () => ({ on: true }) }))).toEqual({
      on: false,
    });
    expect(
      await selfVoiceFlag(ans({ ok: false, json: async () => ({ selfVoice: { on: true } }) })),
    ).toEqual({ on: false });
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await voiceSwitches(down)).toEqual({ filter: false, selfVoice: { on: false } });
  });

  it("asks at most once per FILTER_FLAG_TTL_MS; a failure is off", async () => {
    let on = true;
    let asks = 0;
    let t = 0;
    const sw = selfVoiceSwitch(
      async () => (asks++, { on }),
      () => t,
    );
    expect(await sw()).toEqual({ on: true });
    on = false;
    t = FILTER_FLAG_TTL_MS - 1;
    expect(await sw()).toEqual({ on: true });
    expect(asks).toBe(1);
    t = FILTER_FLAG_TTL_MS;
    expect(await sw()).toEqual({ on: false });
    const broken = selfVoiceSwitch(async () => {
      throw new Error("down");
    });
    expect(await broken()).toEqual({ on: false });
  });

  it("the frame for the Mac: on with the lines given, else plain off", () => {
    expect(JSON.parse(selfVoiceFrame({ on: true, accept: 0.5, margin: 0.2 }))).toEqual({
      t: "selfVoice",
      on: true,
      accept: 0.5,
      margin: 0.2,
    });
    expect(JSON.parse(selfVoiceFrame({ on: true, accept: Number.NaN }))).toEqual({
      t: "selfVoice",
      on: true,
    });
    expect(JSON.parse(selfVoiceFrame({ on: false, accept: 0.5 }))).toEqual({
      t: "selfVoice",
      on: false,
    });
    expect(JSON.parse(selfVoiceFrame(undefined))).toEqual({ t: "selfVoice", on: false });
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

describe("createLocalStt: the selfVoice frame", () => {
  const told = (s: { sent: (string | Uint8Array)[] }) =>
    s.sent
      .filter((f): f is string => typeof f === "string" && f.includes('"selfVoice"'))
      .map((f) => JSON.parse(f));

  it("tells the Mac when the socket opens and when it changes; never repeats itself", async () => {
    const w = sock();
    let conf: { on: boolean; accept?: number } = { on: true, accept: 0.5 };
    const logs: Record<string, unknown>[] = [];
    const c = createLocalStt("wss://mac.ts.net/lianki-stt", {
      open: w.open,
      device: "mac",
      selfVoice: () => conf,
      log: (e) => logs.push(e),
    });
    c.warm();
    const s = w.socks[0]!;
    s.readyState = 1;
    s.say({ t: "ready", engine: "sensevoice", model: "m" });
    await tick();
    expect(told(s)).toEqual([{ t: "selfVoice", on: true, accept: 0.5 }]);
    const u = c.begin(() => {})!;
    await tick();
    expect(told(s)).toHaveLength(1);
    const f = u.end(new Float32Array(10));
    s.say({ t: "final", id: 1, text: "hello", speaker: self() });
    expect((await f).speaker).toEqual(self());
    conf = { on: false };
    c.begin(() => {});
    await tick();
    expect(told(s).at(-1)).toEqual({ t: "selfVoice", on: false });
    s.say({ t: "selfVoice", on: false });
    expect(logs).toContainEqual({ ev: "voice-self", on: false });
  });

  it("no switch, or a failing one: nothing is sent, so the Mac keeps self off", async () => {
    for (const selfVoice of [
      undefined,
      async () => {
        throw new Error("nope");
      },
    ]) {
      const w = sock();
      const c = createLocalStt("wss://mac.ts.net/lianki-stt", {
        open: w.open,
        device: "mac",
        ...(selfVoice ? { selfVoice } : {}),
      });
      c.warm();
      const s = w.socks[0]!;
      s.readyState = 1;
      s.say({ t: "ready", engine: "sensevoice", model: "m" });
      await tick();
      c.begin(() => {});
      await tick();
      expect(told(s)).toEqual([]);
    }
  });
});
