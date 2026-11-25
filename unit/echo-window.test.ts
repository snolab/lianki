/**
 * The play window (lib/echo-reports.ts echoWindowMatch, flag voice.echo-window):
 * a voice line spoken while one of his pages played Lianki audio, or in the
 * short tail after, is an echo whatever its words. Replays the transcripts
 * of 2026-11-26 00:30–00:55 JST, when Whisper on his phone turned read-aloud
 * into words that share nothing with what played.
 */
import { describe, expect, it } from "bun:test";
import { containedSimilarity, normalizeEcho } from "@/lib/echo-match";
import {
  ECHO_HALLUCINATIONS,
  PLAY_OPEN_MAX_MS,
  type PlayReport,
  PlayStore,
  echoHallucinated,
  echoVerdict,
  echoWindowMatch,
  openEnd,
  parsePlayFrame,
} from "@/lib/echo-reports";

const conf = { leadMs: 300, tailMs: 2500, share: 0.5 };
const rep = (o: Partial<PlayReport> & { from: number }): PlayReport => ({
  page: "phone",
  ref: "line1#1",
  voice: "device",
  synced: true,
  seen: o.from,
  ...o,
});

describe("echoWindowMatch", () => {
  it("an utterance inside a play is an echo whatever its words", () => {
    const hit = echoWindowMatch(
      [rep({ from: 1000, to: 7000, text: "MCP metrics 超时" })],
      { from: 2000, to: 4500, known: true },
      conf,
      9000,
      "phone",
    );
    expect(hit).toMatchObject({
      sim: 1,
      voice: "device",
      of: "line1",
      overlapMs: 2500,
      samePage: true,
    });
  });

  it("the tail counts: spoken just after the sound ended", () => {
    const hit = echoWindowMatch(
      [rep({ from: 1000, to: 5000 })],
      { from: 5500, to: 7000, known: true },
      conf,
      9000,
    );
    expect(hit?.sim).toBe(1);
  });

  it("past the tail it is his", () => {
    expect(
      echoWindowMatch(
        [rep({ from: 1000, to: 5000 })],
        { from: 8000, to: 9000, known: true },
        conf,
        9500,
      ),
    ).toBeUndefined();
  });

  it("a long instruction that Li started reading into near its end stays his", () => {
    // 20 s of speech, a sound starts 2 s before it ends: 2.0 s + no tail inside = 10 %.
    expect(
      echoWindowMatch([rep({ from: 18_000 })], { from: 0, to: 20_000, known: true }, conf, 20_500),
    ).toBeUndefined();
  });

  it("joins several sounds without counting their overlap twice", () => {
    const hit = echoWindowMatch(
      [rep({ from: 0, to: 2000, ref: "a#1" }), rep({ from: 1000, to: 3000, ref: "b#2" })],
      { from: 0, to: 10_000, known: true },
      { ...conf, tailMs: 0, leadMs: 0 },
      12_000,
    );
    expect(hit).toBeUndefined(); // 3 s of 10 s
    const both = echoWindowMatch(
      [rep({ from: 0, to: 4000, ref: "a#1" }), rep({ from: 3000, to: 6000, ref: "b#2" })],
      { from: 0, to: 10_000, known: true },
      { ...conf, tailMs: 0, leadMs: 0 },
      12_000,
    );
    expect(both).toMatchObject({ sim: 0.6, overlapMs: 6000 });
  });

  it("a sound with no end yet is open until now", () => {
    expect(
      echoWindowMatch([rep({ from: 1000 })], { from: 3000, to: 4000, known: true }, conf, 4000)
        ?.sim,
    ).toBe(1);
  });

  it("an unsynced page gets twice the margins", () => {
    const r = rep({ from: 1000, to: 5000, synced: false });
    expect(echoWindowMatch([r], { from: 9000, to: 10_000, known: true }, conf, 11_000)?.sim).toBe(
      1,
    );
  });

  it("a guessed span says nothing about 'while'", () => {
    expect(
      echoWindowMatch(
        [rep({ from: 0, to: 9000 })],
        { from: 1000, to: 2000, known: false },
        conf,
        9000,
      ),
    ).toBeUndefined();
  });
});

describe("echoHallucinated", () => {
  it("finds the subtitle credits Whisper writes for non-speech", () => {
    expect(
      echoHallucinated(
        "明镜需要您的支持 欢迎收看订阅明镜的支持 欢迎收看订阅明镜。",
        ECHO_HALLUCINATIONS,
      ),
    ).toBe("明镜需要您的支持");
    expect(echoHallucinated("ご視聴ありがとうございました", ECHO_HALLUCINATIONS)).toBeDefined();
    expect(echoHallucinated("Thanks for watching!", ECHO_HALLUCINATIONS)).toBeDefined();
  });
  it("leaves his words alone", () => {
    expect(
      echoHallucinated("你去看一下这一大堆超时是怎么回事", ECHO_HALLUCINATIONS),
    ).toBeUndefined();
    expect(echoHallucinated("明镜", ECHO_HALLUCINATIONS)).toBeUndefined();
  });
});

describe("folding for any language", () => {
  it("drops accents and widths, keeps every script", () => {
    expect(normalizeEcho("Sennsjánssjáns.")).toBe("sennsjanssjans");
    expect(normalizeEcho("Ｔｉｍｅ．ｉｓ")).toBe("timeis");
    expect(normalizeEcho("café")).toBe(normalizeEcho("cafe"));
    expect(normalizeEcho("表里 alive，只表示进程活着。")).toBe("表里alive只表示进程活着");
  });
  it("an accent STT added does not save an echo", () => {
    expect(containedSimilarity("Résumé the run", "resume the run now")).toBe(1);
  });
});

describe("echoVerdict with the window", () => {
  const window = { sim: 1, voice: "device", of: "line1", overlapMs: 2000, samePage: true };
  it("is a shown read-aloud echo, layer window", () => {
    expect(echoVerdict({ window })).toEqual({
      kind: "read-aloud",
      layer: "window",
      sim: 1,
      of: "line1",
      voice: "device",
      overlapMs: 2000,
      hidden: false,
    });
  });
  it("a strong signed 'me' outvotes it, unless his clone voice played", () => {
    const me = { decision: "me", trust: "signed", score: 0.8 };
    expect(echoVerdict({ window, speaker: me })).toBeUndefined();
    expect(echoVerdict({ window: { ...window, voice: "clone" }, speaker: me })?.layer).toBe(
      "window",
    );
    // An unsigned "me" (a page's say-so) never does.
    expect(echoVerdict({ window, speaker: { decision: "me", score: 0.9 } })?.layer).toBe("window");
  });
  it("noise is the last resort", () => {
    expect(echoVerdict({ noise: { ...window, overlapMs: 0 } })?.layer).toBe("noise");
    expect(echoVerdict({ window, noise: window })?.layer).toBe("window");
  });
});

describe("time-only play reports", () => {
  it("a frame with no words is kept and opens the window", () => {
    const f = parsePlayFrame(
      JSON.stringify({ type: "playing", ref: "p1", voice: "li-player", from: 1000, synced: true }),
    );
    expect(f).toEqual({ type: "playing", ref: "p1", voice: "li-player", from: 1000, synced: true });
    const store = new PlayStore();
    store.note("phone", f!, 1000, 120_000);
    store.note("phone", { type: "played", ref: "p1", to: 4000, synced: true }, 4000, 120_000);
    const over = store.overlapping({ from: 2000, to: 3000 }, 1500, 5000);
    expect(over).toHaveLength(1);
    expect(echoWindowMatch(over, { from: 2000, to: 3000, known: true }, conf, 5000)?.voice).toBe(
      "li-player",
    );
  });
});

describe("long sounds: a lease renewed while playing (review of #1108)", () => {
  const stream = {
    type: "playing" as const,
    ref: "stream",
    voice: "li-player",
    from: 1000,
    synced: true as const,
  };
  it("a stream renewed every 20 s stays open past the 60 s sentence cap", () => {
    const store = new PlayStore();
    store.note("phone", stream, 1000, 120_000);
    for (let t = 21_000; t <= 141_000; t += 20_000)
      store.note("phone", { ...stream, renew: true }, t, 120_000);
    const span = { from: 141_000, to: 142_000, known: true };
    const recent = store.overlapping({ from: span.from - 15_000, to: span.to }, 1500, 143_000);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.from).toBe(1000); // the start never moves
    expect(echoWindowMatch(recent, span, conf, 143_000, "phone")?.sim).toBe(1);
  });
  it("the probe case: speech at 71–72 s of a stream renewed at 61 s is caught", () => {
    const store = new PlayStore();
    store.note("phone", stream, 1000, 120_000);
    store.note("phone", { ...stream, renew: true }, 61_000, 120_000);
    const span = { from: 71_000, to: 72_000, known: true };
    const recent = store.overlapping({ from: span.from - 15_000, to: span.to }, 1500, 73_000);
    expect(echoWindowMatch(recent, span, conf, 73_000, "phone")?.sim).toBe(1);
  });
  it("with no renewal (a lost page) the lease ends it: 30 s after the last renewal", () => {
    expect(openEnd({ from: 0, renewed: 100_000 }, 500_000)).toBe(130_000);
    expect(openEnd({ from: 0 }, 500_000)).toBe(PLAY_OPEN_MAX_MS);
    expect(openEnd({ from: 0, to: 5000, renewed: 100_000 }, 500_000)).toBe(5000);
  });
  it("a renewal after 'played' does not reopen it; one the hub never saw starts a lease", () => {
    const store = new PlayStore();
    store.note("phone", stream, 1000, 120_000);
    store.note("phone", { type: "played", ref: "stream", to: 5000, synced: true }, 5000, 120_000);
    store.note("phone", { ...stream, renew: true }, 21_000, 120_000);
    expect(store.overlapping({ from: 20_000, to: 21_000 }, 0, 21_000)).toEqual([]);
    const fresh = new PlayStore();
    fresh.note("phone", { ...stream, ref: "s2", renew: true }, 50_000, 120_000);
    expect(fresh.overlapping({ from: 70_000, to: 71_000 }, 0, 71_000)).toHaveLength(1);
  });
  it("parses renew only as true", () => {
    expect(parsePlayFrame(JSON.stringify({ ...stream, renew: true }))).toMatchObject({
      renew: true,
    });
    expect(parsePlayFrame(JSON.stringify({ ...stream, renew: "yes" }))).not.toHaveProperty("renew");
  });
});
