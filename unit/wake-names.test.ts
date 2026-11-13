import { describe, expect, it } from "bun:test";
import {
  KWS_TOKENS,
  cmuOf,
  lettersToPhones,
  nameTokens,
  pinyinOf,
  plainToken,
  spellOut,
  syllableTokens,
  toneVariants,
  wordPhones,
} from "@lianki/debug-chat/wake-tokens";
import {
  NAME_SCORE,
  NAME_SCORE_LOOSE,
  NAME_THRESHOLD,
  NAME_THRESHOLD_LOOSE,
  WAKE_SENSE_KEY,
  nameSense,
  buildWakeKeywords,
  clashes,
  createWakeNames,
  editDistance,
  heardName,
  laneSpellings,
  mentionOf,
  wakeNames,
  wakeParticipants,
} from "@lianki/debug-chat/wake-names";
import { LINKY, afterKeyword } from "@lianki/debug-chat/wake";
import { type WorkerLike, createKws, workerSource } from "@lianki/debug-chat/wake-kws";
import { type VadEvents, createMic } from "@lianki/debug-chat/mic";
import { type MicDeps, createMicSession } from "@lianki/debug-chat/mic-session";
import { routeLine } from "@lianki/debug-chat/lane-route";
import { wakeMention } from "@lianki/debug-chat/polish";

const tick = () => new Promise((r) => setTimeout(r, 0));
const RATE = 16_000;

describe("names → model tokens", () => {
  it("Chinese: a pinyin initial and its toned final per character", () => {
    expect(pinyinOf("杰")).toBe("jié");
    expect(nameTokens("杰咪")).toEqual(["j", "ié", "m", "ī"]);
    expect(nameTokens("小克")).toEqual(["x", "iǎo", "k", "è"]);
    expect(nameTokens("林琪")).toEqual(["l", "ín", "q", "í"]);
    // No initial; ü finals; y and w are initials, as in the model's keywords.txt.
    expect(syllableTokens("ér")).toEqual(["ér"]);
    expect(syllableTokens("nǚ")).toEqual(["n", "ǚ"]);
    expect(syllableTokens("yǒu")).toEqual(["y", "ǒu"]);
    expect(syllableTokens("zhōu")).toEqual(["zh", "ōu"]);
    expect(syllableTokens("")).toBeNull();
    expect(syllableTokens("zhqq")).toBeNull();
  });

  it("English: the CMU entry for a known name", () => {
    expect(cmuOf("Coco")).toEqual(["K", "OW1", "K", "OW2"]);
    expect(nameTokens("coco")).toEqual(["K", "OW1", "K", "OW2"]);
    expect(nameTokens("Claude")).toEqual(["K", "L", "AO1", "D"]);
    expect(nameTokens("codex")).toEqual(["K", "OW1", "D", "EH0", "K", "S"]);
    expect(cmuOf("zzzz")).toBeUndefined();
  });

  it("English: letter-to-sound for other names, the first vowel stressed", () => {
    expect(lettersToPhones("momo")).toEqual(["M", "OW1", "M", "OW0"]);
    expect(lettersToPhones("yuki")).toEqual(["Y", "UW1", "K", "IY0"]);
    expect(lettersToPhones("mike")).toEqual(["M", "AY1", "K"]);
    expect(lettersToPhones("knox")).toEqual(["N", "AA1", "K", "S"]);
    expect(lettersToPhones("cecil")).toEqual(["S", "EY1", "S", "IH0", "L"]);
    expect(lettersToPhones("gage")).toEqual(["G", "EY1", "JH"]);
    expect(lettersToPhones("sherlock")).toEqual(["SH", "ER1", "L", "AA0", "K"]);
    expect(lettersToPhones("benn")).toEqual(["B", "EH1", "N"]);
    expect(lettersToPhones("")).toBeNull();
    for (const w of ["quinn", "thatch", "phoebe", "starr", "boyd", "lightning"])
      expect(lettersToPhones(w)!.every((t) => KWS_TOKENS.has(t))).toBe(true);
  });

  it("initialisms are spelled out", () => {
    expect(spellOut("GPT")).toEqual(["JH", "IY1", "P", "IY1", "T", "IY1"]);
    expect(wordPhones("mcp")).toEqual(["EH1", "M", "S", "IY1", "P", "IY1"]);
    expect(wordPhones("AJ")).toEqual(["EY1", "JH", "EY1"]);
    expect(nameTokens("mcp-bot")).toEqual(["EH1", "M", "S", "IY1", "P", "IY1", "B", "AA1", "T"]);
  });

  it("mixes scripts and words; anything unsayable is null", () => {
    expect(nameTokens("Lin琪")).toEqual(["L", "IH1", "N", "q", "í"]);
    expect(nameTokens("Coco Claude")).toEqual(["K", "OW1", "K", "OW2", "K", "L", "AO1", "D"]);
    expect(nameTokens("リンキー")).toBeNull();
    expect(nameTokens("R2D2")).toBeNull();
    expect(nameTokens("🐱")).toBeNull();
    expect(nameTokens("龘")).toBeNull(); // not in the table
    expect(nameTokens("coco 龘")).toBeNull();
    expect(nameTokens("   ")).toBeNull();
    expect(nameTokens("-")).toBeNull();
  });

  it("every token made is one the model has", () => {
    for (const n of ["杰咪", "小克", "学习伙伴", "coco", "snomiao", "Learning Partner"])
      expect(nameTokens(n)!.every((t) => KWS_TOKENS.has(t))).toBe(true);
    expect(plainToken("OW1")).toBe("OW");
    expect(plainToken("iǎo")).toBe("iao");
    expect(plainToken("ǚ")).toBe("u");
  });
});

describe("the wake keyword set", () => {
  it("LINKY first, then the lanes, the main agent, agents present, and him", () => {
    const people = wakeParticipants({ mainName: "Li", agents: ["bot"], owner: "Sno" });
    // One per lane, its other names with it.
    expect(people.slice(0, 3).map((p) => p.name)).toEqual(["coco", "杰咪", "小克"]);
    expect(people[0]!.spellings).toContain("codex");
    expect(people[0]!.spellings).toContain("可可");
    expect(people.map((p) => p.name)).not.toContain("main");
    expect(people.flatMap((p) => p.spellings ?? [])).not.toContain("chat");
    expect(people.at(-1)).toEqual({ name: "Sno", kind: "owner" });
    const s = buildWakeKeywords(people);
    expect(s.entries[0]).toBe(LINKY);
    expect(s.names.map((n) => n.name)).toEqual(["coco", "杰咪", "小克", "Li", "bot", "Sno"]);
    // 小可 is 小克's own spelling now: one entry, no clash.
    expect(s.clash).toEqual([]);
    const coco = s.entries.find((e) => e.label === "agent:coco")!;
    expect(coco).toMatchObject({
      label: "agent:coco",
      score: NAME_SCORE_LOOSE,
      threshold: NAME_THRESHOLD_LOOSE,
    });
    expect(coco.matches[0]).toEqual({ tokens: ["K", "OW1", "K", "OW2"] });
    expect(s.entries.at(-1)!.label).toBe("owner:Sno");
    // Every token sequence is unique (the spotter refuses duplicates).
    const seqs = s.entries.flatMap((e) => e.matches.map((m) => m.tokens.join(" ")));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  // Owner, 2026-11-14: "only 小克 (heard 小课/小客) wakes". Each name had one token
  // sequence in one tone; the model has a token per toned final, so 杰咪 said
  // jié mǐ (STT: 杰米) or jiě mì (解密), and coco said 可可, matched nothing,
  // while 小客 / 小课 happen to be x iǎo k è exactly like 小克.
  it("a name wakes as he says it: any tone, and the lane's Chinese spellings", () => {
    const s = buildWakeKeywords(wakeParticipants({}));
    const said = (label: string) =>
      new Set(s.entries.find((e) => e.label === label)!.matches.map((m) => m.tokens.join(" ")));
    const jiemi = said("agent:杰咪");
    expect(jiemi.has("j ié m ī")).toBe(true); // 杰咪
    expect(jiemi.has("j ié m ǐ")).toBe(true); // 杰米
    expect(jiemi.has("j iě m ì")).toBe(true); // 解密
    const coco = said("agent:coco");
    expect(coco.has("K OW1 K OW2")).toBe(true); // coco
    expect(coco.has("k ě k ě")).toBe(true); // 可可
    expect(coco.has("k ē k ē")).toBe(true); // 科科
    expect(coco.has("K OW1 D EH0 K S")).toBe(true); // codex
    const xiaoke = said("agent:小克");
    expect(xiaoke.has("x iǎo k è")).toBe(true); // 小克, 小客, 小课
    expect(xiaoke.has("x iǎo k ě")).toBe(true); // 小可
    // LINKY's tuned pair is the names' floor; the names run one step looser
    // (owner, 2026-11-14: three names in a row, none woke).
    expect([NAME_SCORE, NAME_THRESHOLD]).toEqual([LINKY.score!, LINKY.threshold!]);
    expect(NAME_SCORE_LOOSE).toBeGreaterThan(NAME_SCORE);
    expect(NAME_THRESHOLD_LOOSE).toBeLessThan(NAME_THRESHOLD);
    expect(laneSpellings("agy")).toContain("杰米");
    expect(laneSpellings("agy")).not.toContain("gemini"); // a word of its own
  });

  it("tone readings: every tone of each Chinese final, Latin tokens kept", () => {
    expect(toneVariants(["j", "ié", "m", "ī"])).toHaveLength(25);
    expect(toneVariants(["j", "ié", "m", "ī"])[0]).toEqual(["j", "ié", "m", "ī"]);
    expect(toneVariants(["n", "ǚ"]).map((t) => t[1])).toEqual(["ǚ", "ǘ", "ǜ"]); // ü stays ü
    expect(toneVariants(["K", "OW1", "K", "OW2"])).toEqual([["K", "OW1", "K", "OW2"]]);
    // Past the cap (four syllables): the spelling alone.
    expect(toneVariants(nameTokens("扣德克斯")!)).toHaveLength(1);
  });

  it("clash: the same sound, one a prefix of the other, or one token apart when short", () => {
    expect(clashes(["K", "OW1", "K", "OW2"], ["K", "OW1", "K", "OW0"])).toBe(true);
    expect(clashes(["AE1", "N"], ["AE1", "N", "AH0"])).toBe(true); // Ann / Anna
    expect(clashes(["K", "OW1", "K", "OW2"], ["K", "OW1", "K", "IY0"])).toBe(true);
    expect(clashes(["K", "OW1", "K", "OW2"], ["JH", "IH1", "M", "IY0"])).toBe(false);
    // Long names may differ in one token.
    const long = ["L", "ER1", "N", "IH0", "NG", "P", "AA1", "R"];
    expect(clashes(long, [...long.slice(0, 7), "T"])).toBe(false);
    expect(editDistance(["a", "b"], ["a", "c", "b"])).toBe(1);
    expect(editDistance([], ["a"])).toBe(1);
  });

  it("a name that sounds like Linky, one said twice, or one with no tokens is left out", () => {
    const s = buildWakeKeywords([
      { name: "Linky", kind: "agent" },
      { name: "Bob", kind: "agent" },
      { name: "BOB", kind: "agent" },
      { name: "リンキー", kind: "agent" },
    ]);
    expect(s.names.map((n) => n.name)).toEqual(["Bob"]);
    expect(s.clash).toEqual([{ name: "Linky", with: "Linky" }]);
    expect(s.skipped).toEqual(["リンキー"]);
  });

  it("which name was heard, and the @mention it puts before the line", () => {
    expect(heardName("agent:coco")).toEqual({ name: "coco", kind: "agent" });
    expect(heardName("owner:Sno")).toEqual({ name: "Sno", kind: "owner" });
    expect(heardName("LINKY")).toBeNull();
    expect(heardName(undefined)).toBeNull();
    expect(mentionOf("agent:coco")).toBe("@coco");
    expect(mentionOf("agent:杰咪")).toBe("@杰咪");
    expect(mentionOf("owner:Sno")).toBe("");
    expect(mentionOf("LINKY")).toBe("");
    // The lane router takes the mentioned line to that lane.
    expect(routeLine(wakeMention("what's next", "@coco")).lanes).toEqual(["codex"]);
    expect(routeLine(wakeMention("看一下", "@杰咪")).lanes).toEqual(["agy"]);
    expect(routeLine(wakeMention("帮我看一下", "@小克"))).toMatchObject({
      lanes: ["chat"],
      addressed: true,
    });
  });

  it("the detection's label is kept with the hit", () => {
    const r = afterKeyword(
      new Float32Array(RATE),
      [{ label: "agent:coco", startTime: 0, timestamps: [0.1], tokens: ["K"] }],
      RATE,
    );
    expect(r.hit && r.label).toBe("agent:coco");
  });
});

describe("the page's wake-name store", () => {
  it("rebuilds on a rename and tells listeners only when the words change", () => {
    const store = createWakeNames();
    const heard: string[][] = [];
    const off = store.subscribe((s) => heard.push(s.names.map((n) => n.name)));
    expect(store.set({ agents: ["bot"] })).toBe(true);
    expect(store.set({ agents: ["bot"] })).toBe(false); // same set: nothing
    // The owner renames bot to Momo.
    expect(store.set({ agents: ["Momo"] })).toBe(true);
    expect(heard.at(-1)).toContain("Momo");
    expect(heard.at(-1)).not.toContain("bot");
    off();
    store.set({ agents: ["Kiki"] });
    expect(heard).toHaveLength(2);
    expect(store.get().names.map((n) => n.name)).toContain("Kiki");
  });

  it("a name seen first keeps its sound: a newcomer's clashing name is left out, the rename stands", () => {
    const store = createWakeNames();
    store.set({ agents: ["Momo"] });
    // A second agent is renamed "Momo" too, and listed first by activity.
    store.set({ agents: ["MOMO2", "Momo"], owner: "Momu" });
    const s = store.get();
    expect(s.names.map((n) => n.name)).toContain("Momo");
    expect(s.clash).toContainEqual({ name: "Momu", with: "Momo" });
  });

  it("one store per page", () => {
    expect(wakeNames()).toBe(wakeNames());
  });
});

/** A Worker that answers like the real one. */
function fakeWorker() {
  const posted: { type: string; keywords?: { label: string }[]; id?: number }[] = [];
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(m) {
      const x = m as (typeof posted)[number];
      posted.push(x);
      const a =
        x.type === "init"
          ? { type: "ready", ms: 1 }
          : x.type === "keywords"
            ? { type: "keywords-set", id: x.id, ...(posted.length > 3 ? { error: "bad" } : {}) }
            : null;
      if (a) queueMicrotask(() => w.onmessage?.({ data: a }));
    },
    terminate() {},
  };
  return { w, posted };
}

describe("the spotter follows the names", () => {
  it("starts with the set as it is, then swaps it in place once per change", async () => {
    const store = createWakeNames();
    store.set({ agents: ["bot"] });
    const f = fakeWorker();
    const logs: Record<string, unknown>[] = [];
    const k = createKws({
      worker: () => f.w,
      allowed: async () => true,
      keywords: store,
      log: (e) => void logs.push(e),
    });
    // Before it loads, a change is only remembered.
    store.set({ agents: ["bot", "Momo"] });
    expect(f.posted).toEqual([]);
    await k.load();
    expect(f.posted.map((m) => m.type)).toEqual(["init"]);
    expect(f.posted[0]!.keywords!.map((e) => e.label)).toContain("agent:Momo");
    // A rename: one swap. The same set again: none.
    store.set({ agents: ["bot", "Mimi"] });
    store.set({ agents: ["bot", "Mimi"] });
    expect(f.posted.map((m) => m.type)).toEqual(["init", "keywords"]);
    expect(f.posted[1]!.keywords!.map((e) => e.label)).toContain("agent:Mimi");
    await tick();
    expect(logs).toContainEqual({ ev: "wake-keywords", ok: true });
    // A refused list is logged; the Worker keeps the old one.
    store.set({ agents: ["bot", "Mimi", "Kiki"] });
    store.set({ agents: ["bot", "Mimi", "Kiki"], owner: "Sno" });
    await tick();
    expect(logs).toContainEqual({ ev: "wake-keywords", ok: false, error: "bad" });
    expect(logs.filter((e) => e.ev === "wake-names").length).toBe(4);
    k.dispose();
    store.set({ agents: ["gone"] });
    expect(f.posted.filter((m) => m.type === "keywords")).toHaveLength(3);
  });

  it("logs the names left out; without a store it is Linky alone", async () => {
    const store = createWakeNames();
    store.set({ agents: ["リンキー"], owner: "晓克" });
    const logs: Record<string, unknown>[] = [];
    const f = fakeWorker();
    await createKws({
      worker: () => f.w,
      allowed: async () => true,
      keywords: store,
      log: (e) => void logs.push(e),
    }).load();
    expect(logs[0]).toMatchObject({
      ev: "wake-names",
      skipped: ["リンキー"],
      clash: [{ name: "晓克", with: "小克" }],
    });
    const g = fakeWorker();
    await createKws({ worker: () => g.w, allowed: async () => true }).load();
    expect(g.posted[0]!.keywords).toEqual([LINKY]);
  });

  it("the Worker swaps keywords with the spotter's setKeywords", () => {
    const src = workerSource({ base: "B/", glue: "g.js", model: "M/", sha: {}, cache: "c" });
    expect(src).toContain("spotter.setKeywords(m.keywords)");
    expect(src).toContain('type: "keywords-set"');
  });
});

describe("a name wakes the mic and addresses the line", () => {
  function gated(label: string | undefined, lead: (l?: string) => string | void = mentionOf) {
    let ev: VadEvents | null = null;
    const texts: string[] = [];
    const logs: Record<string, unknown>[] = [];
    let passive = true;
    const mic = createMic({
      guard: { minFrameRms: 0 },
      load: async (e) => {
        ev = e;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async () => "what's next",
      onState: () => {},
      onText: (t) => texts.push(t),
      onPending: () => {},
      log: (e) => void logs.push(e),
      wake: {
        passive: () => passive,
        spot: async (a) => ({ hit: true, rest: a.subarray(RATE), tokens: ["K"], label }),
        onWake: (l) => {
          passive = false;
          return lead(l);
        },
        verdict: () => {},
      },
    });
    return {
      mic,
      texts,
      logs,
      say(sec: number) {
        ev!.onSpeechStart();
        ev!.onSpeechEnd(new Float32Array(Math.round(sec * RATE)));
      },
    };
  }

  it("'coco, …': the words after the name go up as '@coco …'", async () => {
    const g = gated("agent:coco");
    await g.mic.toggle();
    g.say(3);
    for (let i = 0; i < 4; i++) await tick();
    expect(g.texts).toEqual(["@coco what's next"]);
    expect(g.logs.find((e) => e.ev === "wake-spot")).toMatchObject({ label: "agent:coco" });
  });

  it("'Linky, …' stays as before: no name in front", async () => {
    const g = gated("LINKY");
    await g.mic.toggle();
    g.say(3);
    for (let i = 0; i < 4; i++) await tick();
    expect(g.texts).toEqual(["what's next"]);
  });

  it("the session records which name woke it", async () => {
    let events: VadEvents | null = null;
    const logs: Record<string, unknown>[] = [];
    const texts: string[] = [];
    const deps: MicDeps = {
      guard: { minFrameRms: 0 },
      getStream: async () => ({ id: "s", getTracks: () => [{ readyState: "live", stop() {} }] }),
      load: async (ev) => {
        events = ev;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async () => "看一下",
      log: (ev) => void logs.push(ev),
      kws: (f) => ({
        load: async () => f("ready"),
        spot: async (a) => ({
          hit: true,
          rest: a.subarray(RATE),
          tokens: ["j"],
          label: "agent:杰咪",
        }),
      }),
    };
    const s = createMicSession(deps);
    s.attach({ onText: (t) => texts.push(t), onPending: () => {} });
    await s.toggle();
    s.wake("passive");
    expect(s.view().wake).toBe("passive");
    events!.onSpeechStart();
    events!.onSpeechEnd(new Float32Array(RATE * 3));
    for (let i = 0; i < 6; i++) await tick();
    expect(s.view()).toMatchObject({ wake: "active", wakeName: "杰咪" });
    expect(logs).toContainEqual({ ev: "wake-name", label: "agent:杰咪", kind: "agent" });
    expect(texts).toEqual(["@杰咪 看一下"]);
    expect(routeLine(texts[0]!).lanes).toEqual(["agy"]);
  });

  // Owner, 2026-11-14: "小客 woke it once, then never again". After a wake the
  // mic is active and the spotter is not asked, so a name said again only ever
  // reached the lane as STT wrote it ("小客，…"), which named no lane: nothing
  // called, nothing shown. Now every line that names a lane carries its
  // @mention, and the mic can be woken by name again after going passive.
  it("after a name wake, the next lines that name a lane are mentioned, and it wakes again", async () => {
    let events: VadEvents | null = null;
    const texts: string[] = [];
    const said = ["帮我看一下", "小客，再看一下", "杰米，看日志", "好的"];
    let n = 0;
    const deps: MicDeps = {
      guard: { minFrameRms: 0 },
      getStream: async () => ({ id: "s", getTracks: () => [{ readyState: "live", stop() {} }] }),
      load: async (ev) => {
        events = ev;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async () => said[n++]!,
      kws: (f) => ({
        load: async () => f("ready"),
        spot: async (a) => ({
          hit: true,
          rest: a.subarray(RATE),
          tokens: ["x"],
          label: "agent:小克",
        }),
      }),
    };
    const s = createMicSession(deps);
    s.attach({ onText: (t) => texts.push(t), onPending: () => {} });
    await s.toggle();
    const say = async () => {
      events!.onSpeechStart();
      events!.onSpeechEnd(new Float32Array(RATE * 3));
      for (let i = 0; i < 6; i++) await tick();
    };
    s.wake("passive");
    await say(); // "小克, 帮我看一下" (passive: the spotter heard 小克)
    expect(s.view()).toMatchObject({ wake: "active", wakeName: "小克" });
    await say(); // active: "小客，再看一下"
    await say(); // active: "杰米，看日志"
    expect(texts).toEqual(["@小克 帮我看一下", "@小克 再看一下", "@杰咪 看日志"]);
    expect(texts.map((t) => routeLine(t).lanes)).toEqual([["chat"], ["chat"], ["agy"]]);
    // Passive again, and the name wakes it a second time.
    s.wake("passive");
    expect(s.view().wake).toBe("passive");
    await say();
    expect(s.view().wake).toBe("active");
    expect(texts.at(-1)).toBe("@小克 好的");
  });
});

describe("nameSense: the device's lk:wake-sense pair, else the loose pair", () => {
  it("reads a valid score/threshold pair", () => {
    expect(nameSense((k) => (k === WAKE_SENSE_KEY ? "2.5/0.08" : null))).toEqual({
      score: 2.5,
      threshold: 0.08,
    });
  });
  it("falls back on nothing, junk, or an out-of-range pair", () => {
    const loose = { score: NAME_SCORE_LOOSE, threshold: NAME_THRESHOLD_LOOSE };
    expect(nameSense(() => null)).toEqual(loose);
    expect(nameSense(() => "loose")).toEqual(loose);
    expect(nameSense(() => "0/0.1")).toEqual(loose);
    expect(nameSense(() => "2/1.5")).toEqual(loose);
    expect(
      nameSense(() => {
        throw new Error("no storage");
      }),
    ).toEqual(loose);
  });
});
