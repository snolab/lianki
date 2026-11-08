import { describe, expect, it } from "bun:test";
import {
  clipSeconds,
  parseTimedText,
  timeMs,
  videoIdOf,
  YT_LIMITS,
} from "@/lib/yt-songs/timed-text";
import { songBook, songSourceKey } from "@/lib/yt-songs/song";
import { ytSongsOn } from "@/lib/yt-songs/gate";
import { bookMetaOf, checkYt, parseBookMeta } from "@/lib/read/book";
import { polishRefused } from "@/lib/read/polish-offer";
import { FLAGS } from "@/lib/flags";

const ID = "dQw4w9WgXcQ";

describe("videoIdOf", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&list=PL123&t=42s`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}&feature=share`],
    [`https://youtu.be/${ID}?si=abc`],
    [`youtu.be/${ID}`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
    [ID],
  ])("%s → the id only", (url) => {
    expect(videoIdOf(url)).toBe(ID);
  });

  it.each([
    [""],
    ["not a link"],
    [`https://evil.example/watch?v=${ID}`],
    [`https://youtube.com.evil.example/watch?v=${ID}`],
    [`javascript:alert(1)//youtu.be/${ID}`],
    ["https://www.youtube.com/watch?v=short"],
    ["https://www.youtube.com/channel/UC1234567890"],
    [`https://youtu.be/${ID}x`],
  ])("%s → null", (url) => {
    expect(videoIdOf(url)).toBeNull();
  });
});

describe("timeMs", () => {
  it("reads LRC, SRT and VTT times", () => {
    expect(timeMs("01:23.45")).toBe(83_450);
    expect(timeMs("01:23.4")).toBe(83_400);
    expect(timeMs("01:23.456")).toBe(83_456);
    expect(timeMs("01:23")).toBe(83_000);
    expect(timeMs("00:01:23,456")).toBe(83_456);
    expect(timeMs("1:02:03.5")).toBe(3_723_500);
  });
  it("refuses what is not a time", () => {
    expect(timeMs("ar")).toBeNull();
    expect(timeMs("01:75.00")).toBeNull();
    expect(timeMs("")).toBeNull();
  });
});

describe("parseTimedText: LRC", () => {
  it("lines with ends from the next stamp; the last runs 8 s", () => {
    const r = parseTimedText(
      "[ti:My Song]\n[ar:Someone]\n[00:12.00]First line\n[00:15.50]Second line\n",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.format).toBe("lrc");
    expect(r.title).toBe("My Song");
    expect(r.lines).toEqual([
      { t0: 12_000, t1: 15_500, text: "First line" },
      { t0: 15_500, t1: 15_500 + YT_LIMITS.lastLineMs, text: "Second line" },
    ]);
  });

  it("several stamps on one line: the chorus at each time, all sorted", () => {
    const r = parseTimedText("[00:10.00][00:30.00]Chorus\n[00:20.00]Verse\n[00:40.00]\n");
    if (!r.ok) throw new Error(r.error);
    expect(r.lines.map((l) => [l.t0, l.t1, l.text])).toEqual([
      [10_000, 20_000, "Chorus"],
      [20_000, 30_000, "Verse"],
      [30_000, 40_000, "Chorus"],
    ]);
  });

  it("an empty or wordless stamp ends the line before and is dropped", () => {
    const r = parseTimedText("[00:01.00]Hello\n[00:03.00]♪\n[00:09.00]World\n[00:12.00]");
    if (!r.ok) throw new Error(r.error);
    expect(r.lines).toEqual([
      { t0: 1_000, t1: 3_000, text: "Hello" },
      { t0: 9_000, t1: 12_000, text: "World" },
    ]);
  });

  it("an LRC stamp mm:ss:xx is hundredths, not hours", () => {
    const r = parseTimedText("[01:23:45]A\n[01:25:00]B");
    if (!r.ok) throw new Error(r.error);
    expect(r.lines[0]).toEqual({ t0: 83_450, t1: 85_000, text: "A" });
  });

  it("[offset:] moves every line (positive: sooner)", () => {
    const r = parseTimedText("[offset:+500]\n[00:10.00]A\n[00:12.00]B");
    if (!r.ok) throw new Error(r.error);
    expect(r.lines[0]).toEqual({ t0: 9_500, t1: 11_500, text: "A" });
    const neg = parseTimedText("[offset:-250]\n[00:00.10]A\n[00:01.00]B");
    if (!neg.ok) throw new Error(neg.error);
    expect(neg.lines[0].t0).toBe(350);
  });

  it("karaoke word stamps and markup are text-stripped", () => {
    const r = parseTimedText("[00:01.00]<00:01.00>Hel<00:01.50>lo <b>there</b>\n[00:04.00]x");
    if (!r.ok) throw new Error(r.error);
    expect(r.lines[0].text).toBe("Hel lo there");
  });
});

describe("parseTimedText: SRT and VTT", () => {
  it("SRT: cue ends kept, multi-line cues joined, tags dropped", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "<i>Hello</i>",
      "world",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "{\\an8}Again",
      "",
    ].join("\r\n");
    const r = parseTimedText(srt);
    if (!r.ok) throw new Error(r.error);
    expect(r.format).toBe("srt");
    expect(r.lines).toEqual([
      { t0: 1_000, t1: 3_500, text: "Hello world" },
      { t0: 4_000, t1: 6_000, text: "Again" },
    ]);
  });

  it("VTT: header, NOTE and STYLE skipped, short times and cue settings read", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE a comment --> not a cue? no: this block has no time line",
      "",
      "STYLE",
      "::cue { color: red }",
      "",
      "intro",
      "00:01.000 --> 00:02.500 align:start position:10%",
      "<v Singer>One</v>",
      "",
      "00:00:03.000 --> 00:00:05.000",
      "Two &amp; three",
    ].join("\n");
    const r = parseTimedText(vtt);
    if (!r.ok) throw new Error(r.error);
    expect(r.format).toBe("vtt");
    expect(r.lines).toEqual([
      { t0: 1_000, t1: 2_500, text: "One" },
      { t0: 3_000, t1: 5_000, text: "Two & three" },
    ]);
  });

  it("a cue with no end after its start ends at the next one", () => {
    const r = parseTimedText(
      "00:00:01,000 --> 00:00:01,000\nA\n\n00:00:02,000 --> 00:00:03,000\nB",
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.lines[0]).toEqual({ t0: 1_000, t1: 2_000, text: "A" });
  });
});

describe("parseTimedText: limits and refusals", () => {
  it("plain lines with no timings", () => {
    expect(parseTimedText("just\nsome lyrics")).toEqual({ ok: false, error: "no-timings" });
    expect(parseTimedText("   \n")).toEqual({ ok: false, error: "empty" });
  });
  it("over 64 KB is refused before parsing", () => {
    expect(parseTimedText("[00:01.00]" + "a".repeat(YT_LIMITS.maxBytes))).toEqual({
      ok: false,
      error: "too-large",
    });
  });
  it("over 500 lines is refused, not cut", () => {
    const text = Array.from(
      { length: 501 },
      (_, i) =>
        `[${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.00]l${i}`,
    ).join("\n");
    expect(parseTimedText(text)).toEqual({ ok: false, error: "too-many-lines" });
  });
  it("a line never runs over a minute, and text is capped", () => {
    const r = parseTimedText(`[00:00.00]${"x".repeat(1000)}\n[05:00.00]end`);
    if (!r.ok) throw new Error(r.error);
    expect(r.lines[0].t1).toBe(YT_LIMITS.maxLineMs);
    expect(r.lines[0].text.length).toBe(YT_LIMITS.maxLineChars);
  });
  it("HTML stays text", () => {
    const r = parseTimedText("[00:01.00]<script>alert(1)</script>&lt;b&gt;\n[00:02.00]x");
    if (!r.ok) throw new Error(r.error);
    expect(r.lines[0].text).toBe("alert(1)<b>");
  });
});

describe("clipSeconds", () => {
  it("ms → the player's seconds", () => {
    expect(clipSeconds([12_340, 15_500])).toEqual({ startSeconds: 12.34, endSeconds: 15.5 });
  });
  it("the offset moves both ends; nothing before 0", () => {
    expect(clipSeconds([1_000, 3_000], 500)).toEqual({ startSeconds: 1.5, endSeconds: 3.5 });
    expect(clipSeconds([1_000, 3_000], -2_000)).toEqual({ startSeconds: 0, endSeconds: 1 });
  });
  it("the end stays inside a known duration, and after the start", () => {
    expect(clipSeconds([200_000, 208_000], 0, 205)).toEqual({
      startSeconds: 200,
      endSeconds: 205,
    });
    expect(clipSeconds([5_000, 5_100]).endSeconds).toBeGreaterThan(5);
  });
});

describe("a song as a /read book", () => {
  const timed = [
    { t0: 1_000, t1: 3_000, text: "Hello" },
    { t0: 3_000, t1: 6_000, text: "World" },
  ];
  it("one line per sung line, a clip per line; stored meta reads back", () => {
    const { book, yt } = songBook(ID, "Song", timed);
    expect(book.lines).toEqual(["Hello", "World"]);
    expect(yt).toEqual({
      v: ID,
      offsetMs: 0,
      clips: [
        [1_000, 3_000],
        [3_000, 6_000],
      ],
    });
    const meta = parseBookMeta(JSON.stringify(bookMetaOf(book, { source: "youtube", yt })));
    expect(meta?.source).toBe("youtube");
    expect(meta?.yt).toEqual(yt);
    expect(songSourceKey(ID)).toBe(`youtube:${ID}`);
  });
  it("a bad stored clip drops the clips, never the book", () => {
    expect(checkYt({ v: ID, offsetMs: 0, clips: [[3, 1]] })).toBeNull();
    expect(checkYt({ v: "bad", offsetMs: 0, clips: [] })).toBeNull();
    expect(checkYt({ v: ID, offsetMs: 1e9, clips: [] })).toEqual({ v: ID, offsetMs: 0, clips: [] });
    const { book } = songBook(ID, "Song", timed);
    const raw = { ...bookMetaOf(book, { source: "youtube" }), yt: { v: ID, clips: "x" } };
    const meta = parseBookMeta(JSON.stringify(raw));
    expect(meta?.source).toBe("youtube");
    expect(meta?.yt).toBeUndefined();
  });
  it("clips only on a youtube book", () => {
    const { book, yt } = songBook(ID, "Song", timed);
    const meta = parseBookMeta(JSON.stringify({ ...bookMetaOf(book), yt }));
    expect(meta?.yt).toBeUndefined();
  });
  it("never offered the polish (it would move words off their times)", () => {
    expect(polishRefused({ source: "youtube" })).toBe(true);
  });
});

describe("read.youtube-songs gate", () => {
  it("is a registered flag, default off", () => {
    expect(FLAGS["read.youtube-songs"].default).toBe(false);
  });
  it("the owner always; anyone else only with the flag", () => {
    expect(ytSongsOn({}, true)).toBe(true);
    expect(ytSongsOn({}, false)).toBe(false);
    expect(ytSongsOn(null, false)).toBe(false);
    expect(ytSongsOn({ "read.youtube-songs": true }, false)).toBe(true);
  });
});
