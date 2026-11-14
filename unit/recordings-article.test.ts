// /my/recordings as one article per date (lib/recordings-article.ts): pure parts only, no audio.
import { describe, expect, it } from "bun:test";
import { CONFIG } from "@/lib/config";
import {
  locate,
  nextId,
  paragraphs,
  parseSpeeds,
  playTarget,
  positionMs,
  speedFrom,
  totalMs,
} from "@/lib/recordings-article";
import type { ClipView } from "@/lib/recordings-view";

const DAY = "2026-11-14";
const c = (id: string, at: number, durationMs: number, more: Partial<ClipView> = {}): ClipView => ({
  id,
  day: DAY,
  at,
  durationMs,
  mode: "active",
  source: "local",
  speaker: null,
  text: id,
  ...more,
});

describe("paragraphs: a day's clips as one article", () => {
  it("in recording order, end to end on one timeline (gaps not drawn)", () => {
    const ps = paragraphs([c("b", 60_000, 2_000), c("a", 0, 1_500), c("c", 3_600_000, 500)]);
    expect(ps.map((p) => p.c.id)).toEqual(["a", "b", "c"]);
    expect(ps.map((p) => p.startMs)).toEqual([0, 1_500, 3_500]);
    expect(totalMs(ps)).toBe(4_000);
    expect(totalMs([])).toBe(0);
  });
  it("same time: by id, so the order is stable", () => {
    expect(paragraphs([c("y", 5, 1), c("x", 5, 1)]).map((p) => p.c.id)).toEqual(["x", "y"]);
  });
  it("the speaker/device mark only where it changes", () => {
    const ps = paragraphs([
      c("a", 1, 1, { speaker: "me", device: "iphone" }),
      c("b", 2, 1, { speaker: "me", device: "iphone" }),
      c("c", 3, 1, { speaker: "other", device: "iphone" }),
      c("d", 4, 1, { speaker: "other", device: "mac" }),
      c("e", 5, 1, { speaker: "unknown", device: "mac" }),
      c("f", 6, 1, { speaker: null, device: "mac" }),
    ]);
    expect(ps.map((p) => p.mark)).toEqual([
      { speaker: "me", device: "iphone" },
      null,
      { speaker: "other", device: "iphone" },
      { speaker: "other", device: "mac" },
      { speaker: null, device: "mac" },
      null, // unknown and unchecked read the same
    ]);
  });
  it("no mark on a first paragraph that has nothing to say", () => {
    const ps = paragraphs([c("a", 1, 1), c("b", 2, 1, { device: " " })]);
    expect(ps.map((p) => p.mark)).toEqual([null, null]);
  });
  it("a time only at the start and after a pause longer than the gap (owner, 2026-11-15)", () => {
    const MIN = 60_000;
    // at = when each ended; b starts 5 min after a ended, c 10 min + 1 s after b, d exactly 10 min after c.
    const ps = paragraphs(
      [
        c("a", 10 * MIN, 2_000),
        c("b", 15 * MIN + 3_000, 3_000),
        c("c", 25 * MIN + 3_000 + 1_000 + 4_000, 4_000),
        c("d", 25 * MIN + 3_000 + 1_000 + 4_000 + 10 * MIN + 1_000, 1_000),
      ],
      10 * MIN,
    );
    expect(ps.map((p) => p.time)).toEqual([true, false, true, false]);
    // No gap given: only the first; a negative duration counts as none.
    expect(paragraphs([c("x", 0, 1), c("y", 10 ** 9, -5)]).map((p) => p.time)).toEqual([
      true,
      false,
    ]);
    expect(paragraphs([c("x", 0, 1), c("y", 5 * MIN, -5)], MIN).map((p) => p.time)).toEqual([
      true,
      true,
    ]);
  });
});

describe("the day's timeline: seeking across clips", () => {
  const ps = paragraphs([c("a", 0, 1_000), c("z", 1, 0), c("b", 2, 2_000), c("c", 3, 500)]);
  it("a point belongs to the clip that starts there", () => {
    expect(locate(ps, 0)).toEqual({ index: 0, offsetMs: 0 });
    expect(locate(ps, 999)).toEqual({ index: 0, offsetMs: 999 });
    // "z" has no length: the boundary goes to "b", the clip that plays.
    expect(locate(ps, 1_000)).toEqual({ index: 2, offsetMs: 0 });
    expect(locate(ps, 2_500)).toEqual({ index: 2, offsetMs: 1_500 });
    expect(locate(ps, 3_100)).toEqual({ index: 3, offsetMs: 100 });
  });
  it("clamped to the day; nothing for an empty day", () => {
    expect(locate(ps, -5)).toEqual({ index: 0, offsetMs: 0 });
    expect(locate(ps, 99_999)).toEqual({ index: 3, offsetMs: 500 });
    expect(locate(ps, Number.NaN)).toEqual({ index: 0, offsetMs: 0 });
    expect(locate([], 10)).toBeNull();
  });
  it("the playing clip's currentTime maps back onto the day", () => {
    expect(positionMs(ps[2], 0.5)).toBe(1_500);
    expect(positionMs(ps[2], 99)).toBe(3_000); // the audio ran past the stored duration
    expect(positionMs(ps[3], Number.NaN)).toBe(3_000);
    expect(locate(ps, positionMs(ps[2], 1.2))).toEqual({ index: 2, offsetMs: 1_200 });
  });
  it("the day plays on, clip after clip, and stops at its end", () => {
    expect(nextId(ps, "a")).toBe("z");
    expect(nextId(ps, "c")).toBeNull();
    expect(nextId(ps, "gone")).toBeNull();
  });
});

describe("play-target: what a tap does", () => {
  const tapped = { day: DAY, id: "a" };
  it("nothing playing, or another clip: play this one from its beginning", () => {
    const play = { do: "play", day: DAY, id: "a", fromMs: 0 } as const;
    expect(playTarget(null, tapped)).toEqual(play);
    expect(playTarget({ day: DAY, id: "b", playing: true }, tapped)).toEqual(play);
    expect(playTarget({ day: "2026-11-13", id: "a", playing: true }, tapped)).toEqual(play);
  });
  it("the playing paragraph pauses; the paused current one resumes", () => {
    expect(playTarget({ day: DAY, id: "a", playing: true }, tapped)).toEqual({ do: "pause" });
    expect(playTarget({ day: DAY, id: "a", playing: false }, tapped)).toEqual({ do: "resume" });
  });
  it("'Play from here' always starts the clip over", () => {
    for (const playing of [true, false])
      expect(playTarget({ day: DAY, id: "a", playing }, tapped, true)).toEqual({
        do: "play",
        day: DAY,
        id: "a",
        fromMs: 0,
      });
  });
});

describe("playback speed: a device preference", () => {
  it("the default list is the owner's five", () => {
    expect(parseSpeeds(CONFIG["recordings.speeds"].default)).toEqual([0.75, 1, 1.25, 1.5, 2]);
    expect(CONFIG["recordings.speeds"].schema.safeParse("0.75,1,2").success).toBe(true);
    expect(CONFIG["recordings.speeds"].schema.safeParse("9,1").success).toBe(false);
  });
  it("bad entries dropped, 1 always offered, sorted, no repeats", () => {
    expect(parseSpeeds("2, x, 0.1, 1.5, 2,")).toEqual([1, 1.5, 2]);
    expect(parseSpeeds("")).toEqual([1]);
  });
  it("the stored choice when it is offered, else 1", () => {
    const speeds = [0.75, 1, 1.5];
    expect(speedFrom("1.5", speeds)).toBe(1.5);
    expect(speedFrom("1.25", speeds)).toBe(1);
    expect(speedFrom("fast", speeds)).toBe(1);
    expect(speedFrom(null, speeds)).toBe(1);
    expect(speedFrom("", speeds)).toBe(1);
  });
});

import {
  FOLD_OTHERS_FLAG,
  isClipFolded,
  isOtherSpeaker,
  parseExpandedClips,
} from "@/lib/recordings-article";

describe("recordings other speaker and folding helpers", () => {
  it("identifies other speaker", () => {
    expect(isOtherSpeaker("other")).toBe(true);
    expect(isOtherSpeaker("me")).toBe(false);
    expect(isOtherSpeaker("unknown")).toBe(false);
    expect(isOtherSpeaker(null)).toBe(false);
    expect(isOtherSpeaker(undefined)).toBe(false);
  });

  it("parses expanded clip IDs", () => {
    expect(parseExpandedClips(null)).toEqual(new Set());
    expect(parseExpandedClips("")).toEqual(new Set());
    expect(parseExpandedClips("invalid json")).toEqual(new Set());
    expect(parseExpandedClips(JSON.stringify(["c1", "c2"]))).toEqual(new Set(["c1", "c2"]));
    expect(parseExpandedClips(JSON.stringify(["c1", 123, null]))).toEqual(new Set(["c1"]));
  });
});

describe("isClipFolded (voice.fold-others flag control)", () => {
  it("flag FOLD_OTHERS_FLAG is voice.fold-others", () => {
    expect(FOLD_OTHERS_FLAG).toBe("voice.fold-others");
  });

  it("flag ON (default): folds other speaker clips unless expanded in tab session", () => {
    expect(isClipFolded("other", new Set(), "c1")).toBe(true);
    expect(isClipFolded("other", new Set(), "c1", true)).toBe(true);
    expect(isClipFolded("other", new Set(["c1"]), "c1", true)).toBe(false);
    expect(isClipFolded("me", new Set(), "c2", true)).toBe(false);
  });

  it("flag OFF: never folds even if speaker is other", () => {
    expect(isClipFolded("other", new Set(), "c1", false)).toBe(false);
    expect(isClipFolded("other", new Set(["c1"]), "c1", false)).toBe(false);
    expect(isClipFolded("me", new Set(), "c2", false)).toBe(false);
  });
});
