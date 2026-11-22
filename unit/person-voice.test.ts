import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_PERSON_VOICES,
  PERSON_VOICES_MAX,
  cleanPersonVoices,
  isPersonVoiceId,
  laneVoiceIds,
  personIndex,
  personOf,
  personVoice,
} from "@lianki/debug-chat/person-voice";
import { LOCAL_VOICE_PIN_KEY, NEKO_ROTATION } from "@lianki/debug-chat/voice-heard";
import { LANES, VOICES, VOICE_IDS, auraSpeakers, setCloudVoices } from "@lianki/debug-chat/voices";
import type { SpeakerTag } from "@lianki/debug-chat/wire";
import { stubGlobals } from "./support/globals";

const signed = (o: Partial<SpeakerTag>): SpeakerTag => ({
  decision: "other",
  trust: "signed",
  kid: "mac",
  signed: ["words"],
  ...o,
});

afterEach(() => setCloudVoices(null));

describe("person voices: the pool", () => {
  it("the default pool is disjoint from every lane voice", () => {
    const lanes = laneVoiceIds();
    for (const v of DEFAULT_PERSON_VOICES) {
      expect(lanes.has(v)).toBe(false);
      expect(isPersonVoiceId(v)).toBe(true);
    }
    // The lane table's voices, their Aura speakers, the bright lane's rotation and the calm lane's yunxi.
    for (const id of VOICE_IDS) expect(lanes.has(id)).toBe(true);
    for (const l of Object.values(LANES)) expect(lanes.has(l.voice)).toBe(true);
    for (const s of Object.values(auraSpeakers()).flat()) expect(lanes.has(`aura:${s}`)).toBe(true);
    for (const v of Object.values(VOICES))
      for (const s of Object.values(v.cloud.aura ?? {}))
        expect(isPersonVoiceId(`aura:${s}`)).toBe(false);
    for (const n of NEKO_ROTATION) expect(isPersonVoiceId(`local:${n}`)).toBe(false);
    expect(isPersonVoiceId("local:neko-cycle")).toBe(false);
    expect(isPersonVoiceId("local:yunxi")).toBe(false);
    expect(new Set(DEFAULT_PERSON_VOICES).size).toBe(DEFAULT_PERSON_VOICES.length);
  });

  it("accepts local and provider voices only; never the clone, a preview, a device or Melo voice", () => {
    expect(isPersonVoiceId("google:en-US-Wavenet-D")).toBe(true);
    expect(isPersonVoiceId("azure:zh-TW-HsiaoChenNeural")).toBe(true);
    for (const bad of [
      "clone",
      "main",
      "melo:zh",
      "device:Meijia",
      "eleven:cgSgspJ2msm6clMCkdW9",
      "local:nope",
      "",
      3,
    ])
      expect(isPersonVoiceId(bad)).toBe(false);
  });

  it("cleans a config value: valid, once each, capped; not an array = the default", () => {
    expect(cleanPersonVoices(["local:bella", "local:bella", "main", "local:heart"])).toEqual([
      "local:bella",
      "local:heart",
    ]);
    expect(cleanPersonVoices(null)).toEqual([...DEFAULT_PERSON_VOICES]);
    expect(cleanPersonVoices([])).toEqual([]);
    const many = Array.from(
      { length: 30 },
      (_, i) => `google:en-US-Wavenet-${String.fromCharCode(65 + (i % 26))}${i}`,
    );
    expect(cleanPersonVoices(many).length).toBe(PERSON_VOICES_MAX);
  });
});

describe("person voices: who, and which voice", () => {
  it("only a verified other with a cluster or voice id; unknown, self, me, unsigned, no id: none", () => {
    expect(personOf(signed({ cluster: "A", voice: "s3" }))).toBe("A");
    expect(personOf(signed({ voice: "s3" }))).toBe("s3");
    expect(personOf(signed({ cluster: "household:mei" }))).toBe("household:mei");
    expect(personOf(signed({}))).toBeUndefined();
    expect(personOf(signed({ voice: "me" }))).toBeUndefined();
    expect(personOf(signed({ decision: "unknown", cluster: "A" }))).toBeUndefined();
    expect(personOf(signed({ decision: "self", cluster: "A" }))).toBeUndefined();
    expect(personOf(signed({ decision: "me", voice: "me" }))).toBeUndefined();
    expect(personOf({ decision: "other", cluster: "A" })).toBeUndefined();
    expect(personOf(undefined)).toBeUndefined();
  });

  it("a stable pick per id, counted as the avatars count", () => {
    expect(personIndex("A")).toBe(0);
    expect(personIndex("B")).toBe(1);
    expect(personIndex("AA")).toBe(26);
    expect(personIndex("s1")).toBe(0);
    expect(personIndex("s4")).toBe(3);
    expect(personIndex("household:mei")).toBe(personIndex("household:mei"));
    const pool = DEFAULT_PERSON_VOICES;
    expect(personVoice("A", pool, undefined, new Set())).toEqual({ kind: "local", name: "bella" });
    expect(personVoice("B", pool, undefined, new Set())).toEqual({ kind: "local", name: "heart" });
    expect(personVoice("E", pool, undefined, new Set())).toEqual(
      personVoice("A", pool, undefined, new Set()),
    );
    for (let i = 0; i < 5; i++)
      expect(personVoice("household:mei", pool, undefined, new Set())).toEqual(
        personVoice("household:mei", pool, undefined, new Set()),
      );
    const ids = ["A", "B", "C", "D"].map((id) =>
      JSON.stringify(personVoice(id, pool, undefined, new Set())),
    );
    expect(new Set(ids).size).toBe(4);
    expect(personVoice("A", [], undefined, new Set())).toBeUndefined();
  });

  it("leaves out the voices a lane reads in on this page: the pinned one, the language map's", () => {
    const restore = stubGlobals({
      localStorage: { getItem: (k: string) => (k === LOCAL_VOICE_PIN_KEY ? "bella" : null) },
    });
    try {
      expect(personVoice("A", DEFAULT_PERSON_VOICES)).toEqual({ kind: "local", name: "heart" });
    } finally {
      restore();
    }
    setCloudVoices({ on: true, map: { "zh-TW": "google:cmn-TW-Wavenet-A" } });
    expect(personVoice("A", ["google:cmn-TW-Wavenet-A", "local:heart"], "zh-TW")).toEqual({
      kind: "local",
      name: "heart",
    });
  });
});
