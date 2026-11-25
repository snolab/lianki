/**
 * Cross-device echo, the hub's pure side (lib/echo-reports.ts;
 * docs/echo-suppression.md, layer (b) and "The verdict, in one place").
 */
import { describe, expect, it } from "bun:test";
import { echoMatch, type EchoLine } from "@/lib/echo-match";
import {
  ECHO_PLAY_KEEP_MS,
  ECHO_PLAY_SIMILARITY,
  ECHO_SLACK_MS,
  PLAY_OPEN_MAX_MS,
  PlayStore,
  echoReportMatch,
  echoVerdict,
  parsePlayFrame,
  SELF_ME_MARGIN,
  signedSelf,
  strongMe,
  utteranceSpan,
} from "@/lib/echo-reports";
import { gramHashes } from "@lianki/debug-chat/echo";

const J = JSON.stringify;
const conf = { similarity: ECHO_PLAY_SIMILARITY, minChars: 4, slackMs: ECHO_SLACK_MS };

/** The agent line of 2026-11-19 ~14:25 JST, read aloud on his phone. */
const AGENT =
  "先放一个占位首页，通过 GitHub Actions 自动部署到 Cloudflare Pages，等域名解析好了再换成正式的首页。";
/** What his Mac's mic made of it: "GitHub Actions" mangled. */
const HEARD = "先放一个占位首页，通过给他不爱可信自动部署";

describe("play frames", () => {
  it("parses playing and played, and refuses anything else", () => {
    expect(
      parsePlayFrame(
        J({
          type: "playing",
          ref: "a1#3",
          text: " hi there ",
          voice: "melo",
          from: 5,
          synced: true,
        }),
      ),
    ).toEqual({
      type: "playing",
      ref: "a1#3",
      text: " hi there ",
      voice: "melo",
      from: 5,
      synced: true,
    });
    expect(parsePlayFrame(J({ type: "played", ref: "a1#3", to: 9 }))).toEqual({
      type: "played",
      ref: "a1#3",
      to: 9,
    });
    expect(parsePlayFrame(J({ type: "played", ref: "a1#3", to: 9, synced: true }))?.type).toBe(
      "played",
    );
    for (const bad of [
      42,
      "{}",
      '{"type":"playing"',
      J({ type: "clock", t0: 1 }),
      J({ type: "played", ref: "x", to: -1 }),
      J({ type: "played", ref: "bad ref!", to: 1 }),
      J({ type: "playing", ref: "x", text: "hi", voice: "no spaces", from: 1 }),
      J({ type: "playing", ref: "x", text: "hi", voice: "melo", from: Number.NaN }),
      J({ type: "playing", ref: "x", text: "hi", voice: "melo" }),
      J({ type: "playit", ref: "x" }),
      '{"type":"playing", nope}',
      `{"type":"playing","ref":"x","text":"${"a".repeat(70_000)}"}`,
    ])
      expect(parsePlayFrame(bad)).toBeNull();
  });

  it("cuts long text, keeps the written form, and takes hashed grams only without text", () => {
    const f = parsePlayFrame(
      J({
        type: "playing",
        ref: "p1",
        text: "x".repeat(3000),
        alt: "written",
        voice: "device",
        from: 1,
      }),
    );
    expect(f?.type === "playing" && f.text?.length).toBe(2000);
    expect(f?.type === "playing" && f.alt).toBe("written");
    const h = parsePlayFrame(
      J({
        type: "playing",
        ref: "p2",
        g2: ["ab", "BAD!", 3],
        g3: ["cd"],
        voice: "reader",
        from: 1,
      }),
    );
    expect(h).toEqual({
      type: "playing",
      ref: "p2",
      g2: ["ab"],
      g3: ["cd"],
      voice: "reader",
      from: 1,
    });
    // Text wins: the hashes are dropped beside it.
    const both = parsePlayFrame(
      J({ type: "playing", ref: "p3", text: "hi", g2: ["ab"], voice: "reader", from: 1 }),
    );
    expect(both).toEqual({ type: "playing", ref: "p3", text: "hi", voice: "reader", from: 1 });
    // No words at all: a time-only report (the play window), never a text match.
    expect(parsePlayFrame(J({ type: "playing", ref: "x", voice: "melo", from: 1 }))).toEqual({
      type: "playing",
      ref: "x",
      voice: "melo",
      from: 1,
    });
    expect(parsePlayFrame(J({ type: "playing", ref: "p4", g2: [], voice: "r", from: 1 }))).toEqual({
      type: "playing",
      ref: "p4",
      voice: "r",
      from: 1,
    });
    expect(
      parsePlayFrame(J({ type: "playing", ref: "p5", g2: "ab", voice: "r", from: 1 })),
    ).toEqual({ type: "playing", ref: "p5", voice: "r", from: 1 });
  });
});

describe("the play store", () => {
  const playing = (ref: string, from: number, extra: object = {}) =>
    parsePlayFrame(
      J({
        type: "playing",
        ref,
        text: "hello there friend",
        voice: "melo",
        from,
        synced: true,
        ...extra,
      }),
    )!;

  it("keeps a synced page's own times, and the receive time for an unsynced or implausible one", () => {
    const s = new PlayStore();
    s.note("a", playing("r1", 1000), 1200, ECHO_PLAY_KEEP_MS);
    s.note("a", playing("r2", 1000, { synced: undefined }), 1200, ECHO_PLAY_KEEP_MS);
    s.note("a", playing("r3", 900_000), 1200, ECHO_PLAY_KEEP_MS);
    const all = s.overlapping({ from: 0, to: 2_000_000 }, 0, 1200);
    expect(all.map((r) => [r.ref, r.from, r.synced])).toEqual([
      ["r1", 1000, true],
      ["r2", 1200, false],
      ["r3", 1200, true],
    ]);
  });

  it("closes a report with played, never before it began; ignores an unknown one", () => {
    const s = new PlayStore();
    s.note("a", playing("r1", 1000), 1000, ECHO_PLAY_KEEP_MS);
    s.note("a", { type: "played", ref: "r1", to: 3000, synced: true }, 3000, ECHO_PLAY_KEEP_MS);
    s.note("a", { type: "played", ref: "nope", to: 3000 }, 3000, ECHO_PLAY_KEEP_MS);
    // Same ref from another page is another sound.
    s.note("b", { type: "played", ref: "r1", to: 500, synced: true }, 3000, ECHO_PLAY_KEEP_MS);
    expect(s.size).toBe(1);
    expect(s.overlapping({ from: 2900, to: 2950 }, 0, 4000).map((r) => r.to)).toEqual([3000]);
    s.note("a", { type: "played", ref: "r1", to: 10, synced: true }, 3000, ECHO_PLAY_KEEP_MS);
    expect(s.overlapping({ from: 0, to: 5000 }, 0, 5000)[0]!.to).toBe(1000);
  });

  it("matches by overlap with slack (twice for an unsynced page), an open report up to its cap", () => {
    const s = new PlayStore();
    s.note("a", playing("r1", 10_000), 10_000, ECHO_PLAY_KEEP_MS);
    s.note("a", { type: "played", ref: "r1", to: 12_000, synced: true }, 12_000, ECHO_PLAY_KEEP_MS);
    expect(s.overlapping({ from: 13_000, to: 14_000 }, 1500, 14_000)).toHaveLength(1);
    expect(s.overlapping({ from: 13_600, to: 14_000 }, 1500, 14_000)).toHaveLength(0);
    expect(s.overlapping({ from: 7_000, to: 8_400 }, 1500, 14_000)).toHaveLength(0);
    s.note("b", playing("u1", 0, { synced: undefined }), 20_000, ECHO_PLAY_KEEP_MS);
    s.note("b", { type: "played", ref: "u1", to: 0 }, 21_000, ECHO_PLAY_KEEP_MS);
    // Unsynced: slack 3000 each side of [20 000, 21 000].
    expect(s.overlapping({ from: 23_500, to: 24_000 }, 1500, 24_000).map((r) => r.ref)).toEqual([
      "u1",
    ]);
    // An open report counts up to now, at most PLAY_OPEN_MAX_MS after it began.
    s.note("c", playing("o1", 30_000), 30_000, ECHO_PLAY_KEEP_MS);
    expect(s.overlapping({ from: 50_000, to: 51_000 }, 0, 51_000).map((r) => r.ref)).toEqual([
      "o1",
    ]);
    const late = 30_000 + PLAY_OPEN_MAX_MS + 5000;
    expect(s.overlapping({ from: late, to: late + 10 }, 0, late + 10).map((r) => r.ref)).toEqual(
      [],
    );
  });

  it("forgets by age and by count, and a re-sent ref replaces the old one", () => {
    const s = new PlayStore(3);
    for (let i = 0; i < 5; i++) s.note("a", playing(`r${i}`, i), i, ECHO_PLAY_KEEP_MS);
    expect(s.size).toBe(3);
    s.note("a", playing("r4", 100), 100, ECHO_PLAY_KEEP_MS);
    expect(s.size).toBe(3);
    s.prune(10_000, 1000);
    expect(s.size).toBe(0);
    s.note("a", playing("x", 0, { g2: ["aa"], g3: ["bb"], text: undefined }), 0, ECHO_PLAY_KEEP_MS);
    expect([...s.overlapping({ from: 0, to: 1 }, 0, 1)[0]!.g2!]).toEqual(["aa"]);
  });
});

describe("the utterance's span on the hub's clock", () => {
  it("takes the page's own hub span when it is plausible", () => {
    expect(utteranceSpan(100_000, undefined, { from: 90_000, to: 95_000 })).toEqual({
      from: 90_000,
      to: 95_000,
      known: true,
    });
    // Out of order, or in the far future or past: not used.
    expect(utteranceSpan(100_000, undefined, { from: 96_000, to: 95_000 }).known).toBe(false);
    expect(utteranceSpan(100_000, undefined, { from: 90_000, to: 200_000 }).known).toBe(false);
    expect(utteranceSpan(1_000_000, undefined, { from: 1, to: 2 }).known).toBe(false);
  });

  it("moves the page's timing by the receive time: no clock needed", () => {
    expect(utteranceSpan(50_000, { t_speechStart: 1000, t_speechEnd: 4000, t_sent: 5000 })).toEqual(
      { from: 46_000, to: 49_000, known: true },
    );
    expect(utteranceSpan(50_000, { t_speechEnd: 4000, t_sent: 5000, audioMs: 2000 })).toEqual({
      from: 47_000,
      to: 49_000,
      known: true,
    });
    expect(utteranceSpan(50_000, { t_speechEnd: 4000, t_sent: 5000 })).toEqual({
      from: 49_000,
      to: 49_000,
      known: true,
    });
  });

  it("guesses wide for a line resent long after, or one with no timing", () => {
    expect(utteranceSpan(500_000, { t_speechEnd: 0, t_sent: 120_000, audioMs: 3000 })).toEqual({
      from: 492_000,
      to: 500_000,
      known: false,
    });
    expect(utteranceSpan(500_000)).toEqual({ from: 485_000, to: 500_000, known: false });
    // t_sent before the end (a broken clock): no use either.
    expect(utteranceSpan(500_000, { t_speechEnd: 10, t_sent: 5 }).known).toBe(false);
  });
});

describe("the report match", () => {
  const store = (reports: [string, string, number, number, string?, string?][]) => {
    const s = new PlayStore();
    for (const [page, ref, from, to, text, voice] of reports) {
      s.note(
        page,
        parsePlayFrame(
          J({
            type: "playing",
            ref,
            text: text ?? AGENT,
            voice: voice ?? "device",
            from,
            synced: true,
          }),
        )!,
        from,
        ECHO_PLAY_KEEP_MS,
      );
      s.note(page, { type: "played", ref, to, synced: true }, to, ECHO_PLAY_KEEP_MS);
    }
    return s;
  };

  it("finds a fragment of a sentence playing then, names its line and voice", () => {
    const s = store([["phone", "d3c3#2", 10_000, 18_000]]);
    const span = { from: 11_000, to: 16_000 };
    const hit = echoReportMatch(HEARD, s.overlapping(span, 1500, 20_000), span, conf, "mac");
    expect(hit).toMatchObject({ voice: "device", of: "d3c3", samePage: false, overlapMs: 5000 });
    expect(hit!.sim).toBeGreaterThanOrEqual(0.6);
    expect(
      echoReportMatch(HEARD, s.overlapping(span, 1500, 20_000), span, conf, "phone")?.samePage,
    ).toBe(true);
    expect(echoReportMatch(HEARD, s.overlapping(span, 1500, 20_000), span, conf)?.samePage).toBe(
      false,
    );
  });

  it("compares the written form too, and joins sentences in order", () => {
    const s = new PlayStore();
    s.note(
      "phone",
      parsePlayFrame(
        J({
          type: "playing",
          ref: "p1",
          text: "test eye dee",
          alt: "Test ID",
          voice: "melo",
          from: 0,
          synced: true,
        }),
      )!,
      0,
      ECHO_PLAY_KEEP_MS,
    );
    const span = { from: 0, to: 100 };
    expect(echoReportMatch("test id", s.overlapping(span, 0, 100), span, conf)?.sim).toBe(1);
    const two = store([
      ["phone", "a#1", 0, 1000, "我们先看一下日志"],
      ["phone", "a#2", 1000, 2000, "然后再决定要不要回滚"],
    ]);
    const s2 = { from: 500, to: 1500 };
    const hit = echoReportMatch("看一下日志然后再决定", two.overlapping(s2, 0, 3000), s2, conf);
    expect(hit?.sim).toBe(1);
    expect(hit?.of).toBe("a");
  });

  it("his own different words, or too short a line, or nothing near: no match", () => {
    const s = store([["phone", "x#1", 0, 5000]]);
    const span = { from: 1000, to: 3000 };
    const near = s.overlapping(span, 1500, 6000);
    expect(echoReportMatch("我们明天去公园散步吧", near, span, conf)).toBeUndefined();
    expect(echoReportMatch("首页", near, span, conf)).toBeUndefined();
    expect(echoReportMatch(HEARD, [], span, conf)).toBeUndefined();
  });

  it("matches a private screen's hashed n-grams, and names no line for a page sound", () => {
    const s = new PlayStore();
    const said = "The quick brown fox jumps over the lazy dog near the river bank";
    s.note(
      "phone",
      parsePlayFrame(
        J({
          type: "playing",
          ref: "p9",
          g2: gramHashes(said, 2),
          g3: gramHashes(said, 3),
          voice: "reader",
          from: 0,
          synced: true,
        }),
      )!,
      0,
      ECHO_PLAY_KEEP_MS,
    );
    const span = { from: 0, to: 1000 };
    const hit = echoReportMatch(
      "fox jumps over the lazy dog",
      s.overlapping(span, 0, 1000),
      span,
      conf,
    );
    expect(hit?.sim).toBe(1);
    expect(hit?.of).toBeUndefined();
    expect(hit?.voice).toBe("reader");
    expect(
      echoReportMatch("completely other words here", s.overlapping(span, 0, 1000), span, conf),
    ).toBeUndefined();
  });
});

describe("the verdict", () => {
  const report = { sim: 0.7, voice: "device", of: "d3c3", overlapMs: 4000, samePage: false };
  const me = { decision: "me", trust: "signed", signed: ["x"] };

  it("a strong me is a signed me only", () => {
    expect(strongMe(me)).toBe(true);
    expect(strongMe({ decision: "me", signed: ["x"] })).toBe(true);
    expect(strongMe({ decision: "me" })).toBe(false);
    expect(strongMe({ decision: "me", trust: "advisory", signed: ["x"] })).toBe(false);
    expect(strongMe({ decision: "other", trust: "signed" })).toBe(false);
    expect(strongMe(undefined)).toBe(false);
  });

  it("a report wins, shown; a strong me overrides it unless the clone was playing", () => {
    expect(echoVerdict({ report })).toEqual({
      kind: "read-aloud",
      layer: "report",
      sim: 0.7,
      of: "d3c3",
      voice: "device",
      overlapMs: 4000,
      hidden: false,
    });
    expect(echoVerdict({ report: { ...report, of: undefined } })).not.toHaveProperty("of");
    expect(echoVerdict({ report, speaker: me })).toBeUndefined();
    expect(echoVerdict({ report: { ...report, voice: "clone" }, speaker: me })?.layer).toBe(
      "report",
    );
  });

  it("our own TTS voice, signed by the Mac, is a self-voice echo first; shown collapsed", () => {
    const self = {
      decision: "self",
      trust: "signed",
      signed: ["x"],
      selfScore: 0.71,
      selfVoice: "melo-zh",
    };
    expect(signedSelf(self)).toBe(true);
    // Never on a page's say-so: unsigned or advisory is no evidence.
    expect(signedSelf({ decision: "self" })).toBe(false);
    expect(signedSelf({ decision: "self", trust: "advisory", signed: ["x"] })).toBe(false);
    expect(signedSelf({ decision: "self", signed: ["x"] })).toBe(true); // stored before the ring
    expect(echoVerdict({ speaker: self })).toEqual({
      kind: "self-voice",
      layer: "self",
      sim: 0.71,
      voice: "melo-zh",
      hidden: false,
    });
    // With a play report too: still self, naming the line it echoed and the overlap.
    expect(echoVerdict({ report, speaker: self })).toEqual({
      kind: "self-voice",
      layer: "self",
      sim: 0.71,
      of: "d3c3",
      voice: "melo-zh",
      overlapMs: 4000,
      hidden: false,
    });
    expect(echoVerdict({ speaker: self, landedOf: "a9" })?.of).toBe("a9");
    // Flag stt.self-voice off: the tag is no evidence; the report alone decides.
    expect(echoVerdict({ speaker: self, selfOn: false })).toBeUndefined();
    expect(echoVerdict({ report, speaker: self, selfOn: false })?.kind).toBe("read-aloud");
    expect(echoVerdict({ speaker: { ...self, trust: undefined, signed: [] } })).toBeUndefined();
  });

  it("a strong me must beat our self print by stt.selfMeMargin to outvote a report", () => {
    const close = { ...me, score: 0.5, selfScore: 0.45 };
    const clear = { ...me, score: 0.6, selfScore: 0.2 };
    expect(SELF_ME_MARGIN).toBe(0.1);
    expect(strongMe(close)).toBe(false);
    expect(strongMe(clear)).toBe(true);
    expect(strongMe(close, 0.04)).toBe(true);
    expect(echoVerdict({ report, speaker: close })?.kind).toBe("read-aloud");
    expect(echoVerdict({ report, speaker: clear })).toBeUndefined();
    expect(echoVerdict({ report, speaker: close, selfMeMargin: 0 })).toBeUndefined();
    // No self score (no self print on the Mac): a signed me alone, as before.
    expect(strongMe({ ...me, score: 0.5 })).toBe(true);
  });

  it("falls back to today's landed rule: read-aloud shown, his other device hidden", () => {
    const line = (x: Partial<EchoLine>): EchoLine => ({
      id: "a1",
      from: "agent",
      label: "lane",
      text: AGENT,
      at: 0,
      ...x,
    });
    const c = { windowMs: 8000, readWindowMs: 60_000, similarity: 0.8, minChars: 4 };
    const read = echoMatch(
      [["k", line({})]],
      { text: AGENT.slice(0, 20), label: "mac", at: 1000 },
      c,
    );
    expect(echoVerdict({ landed: read, landedOf: "a1" })).toEqual({
      kind: "read-aloud",
      layer: "landed",
      sim: 1,
      of: "a1",
      hidden: false,
    });
    const dup = echoMatch(
      [["k", line({ from: "owner", label: "phone", text: "我们明天去公园散步吧" })]],
      { text: "我们明天去公园散步吧", label: "mac", at: 1000 },
      c,
    );
    expect(echoVerdict({ landed: dup })).toEqual({
      kind: "other-device",
      layer: "landed",
      sim: 1,
      hidden: true,
    });
    // A strong me does not lift today's rule.
    expect(echoVerdict({ landed: dup, speaker: me })?.hidden).toBe(true);
    expect(echoVerdict({})).toBeUndefined();
  });

  it("replays 2026-11-19 14:25: today's rule lets it through, the play report catches it", () => {
    // The agent line landed at 0; the phone read it from 75 s (a long queue)
    // to 83 s; the Mac heard the fragment from 76 s to 80 s, posted at 81.5 s.
    const kept: [string, EchoLine][] = [
      ["k", { id: "d3c3", from: "agent", label: "lane", text: AGENT, at: 0 }],
    ];
    const c = { windowMs: 8000, readWindowMs: 60_000, similarity: 0.8, minChars: 4 };
    const at = 81_500;
    expect(echoMatch(kept, { text: HEARD, label: "mac", at }, c)).toBeUndefined();
    // Even inside the window, the mangled words stay under 0.8.
    expect(echoMatch(kept, { text: HEARD, label: "mac", at: 30_000 }, c)).toBeUndefined();
    const s = new PlayStore();
    s.note(
      "phone",
      parsePlayFrame(
        J({
          type: "playing",
          ref: "d3c3#1",
          text: AGENT,
          voice: "device",
          from: 75_000,
          synced: true,
        }),
      )!,
      75_050,
      ECHO_PLAY_KEEP_MS,
    );
    s.note(
      "phone",
      { type: "played", ref: "d3c3#1", to: 83_000, synced: true },
      83_040,
      ECHO_PLAY_KEEP_MS,
    );
    const span = utteranceSpan(at, { t_speechStart: 6_000, t_speechEnd: 10_000, t_sent: 11_500 });
    expect(span).toEqual({ from: 76_000, to: 80_000, known: true });
    const report = echoReportMatch(
      HEARD,
      s.overlapping(span, ECHO_SLACK_MS, at),
      span,
      conf,
      "mac",
    );
    expect(echoVerdict(report ? { report } : {})).toMatchObject({
      kind: "read-aloud",
      layer: "report",
      of: "d3c3",
      hidden: false,
    });
  });
});
