import { describe, expect, it } from "bun:test";
import {
  initialPlayer,
  playerReducer,
  readLang,
  speechChunks,
  type PlayerCfg,
  type PlayerEvent,
  type PlayerState,
} from "@/lib/read/player";

// A book: 0 heading, 1–3 text, 4 blank, 5 heading, 6 text (the last line).
const lines = ["Chapter 1", "One.", "Two.", "Three.", "", "Chapter 2", "Four."];
const cfg = (auto = false): PlayerCfg => ({
  total: lines.length,
  auto,
  isHeading: (i) => i === 0 || i === 5,
  isBlank: (i) => !lines[i].trim(),
});
const run = (s: PlayerState, events: PlayerEvent[], c = cfg()) =>
  events.reduce((x, e) => playerReducer(x, e, c), s);
const end = (s: PlayerState): PlayerEvent => ({ type: "ended", token: s.token });

describe("read player: wait mode (default)", () => {
  it("play reads the current line, then waits for the reader", () => {
    let s = run(initialPlayer(1), [{ type: "play" }]);
    expect(s).toMatchObject({ status: "speaking", line: 1, token: 1 });
    s = run(s, [end(s)]);
    expect(s).toMatchObject({ status: "waiting", line: 1 });
  });

  it("never advances on its own: only Next, a tapped line, or shadowing moves on", () => {
    let s = run(initialPlayer(1), [{ type: "play" }]);
    s = run(s, [end(s)]);
    // Nothing else happens until the reader acts.
    expect(s.status).toBe("waiting");
    s = run(s, [{ type: "next" }]);
    expect(s).toMatchObject({ status: "speaking", line: 2, token: 2 });
    s = run(s, [end(s), { type: "select", line: 6 }]);
    expect(s).toMatchObject({ status: "speaking", line: 6 });
  });

  it("a heading is read and then read on, even in wait mode", () => {
    let s = run(initialPlayer(0), [{ type: "play" }]);
    expect(s.line).toBe(0);
    s = run(s, [end(s)]);
    expect(s).toMatchObject({ status: "speaking", line: 1 });
  });

  it("blank lines are skipped without being spoken, into the next chapter", () => {
    let s = run(initialPlayer(3), [{ type: "play" }]);
    s = run(s, [end(s), { type: "next" }]);
    // 4 is blank: straight to the heading at 5, which reads on to 6.
    expect(s).toMatchObject({ status: "speaking", line: 5 });
    s = run(s, [end(s)]);
    expect(s).toMatchObject({ status: "speaking", line: 6 });
  });

  it("stops at the end", () => {
    let s = run(initialPlayer(6), [{ type: "play" }]);
    s = run(s, [end(s), { type: "next" }]);
    expect(s).toMatchObject({ status: "ended", line: 6 });
    // Play again starts the text over.
    expect(run(s, [{ type: "play" }])).toMatchObject({ status: "speaking", line: 0 });
  });
});

describe("read player: auto mode", () => {
  it("reads on line after line, only on each line's real end, and stops at the end", () => {
    let s = run(initialPlayer(1), [{ type: "play" }], cfg(true));
    const seen = [s.line];
    for (let i = 0; i < 10 && s.status === "speaking"; i++) {
      s = run(s, [end(s)], cfg(true));
      if (s.status === "speaking") seen.push(s.line);
    }
    expect(seen).toEqual([1, 2, 3, 5, 6]);
    expect(s.status).toBe("ended");
  });
});

describe("read player: no racing", () => {
  it("a stale end (an older utterance) is ignored", () => {
    let s = run(initialPlayer(1), [{ type: "play" }], cfg(true));
    const old = end(s);
    s = run(s, [old], cfg(true));
    expect(s.line).toBe(2);
    // The first line's onend arriving again does not skip line 2.
    expect(run(s, [old, old, old], cfg(true)).line).toBe(2);
  });

  it("an end after Pause does not move on", () => {
    let s = run(initialPlayer(1), [{ type: "play" }], cfg(true));
    const e = end(s);
    s = run(s, [{ type: "stop" }, e], cfg(true));
    expect(s).toMatchObject({ status: "idle", line: 1 });
  });

  it("a TTS failure stops playback with its message instead of advancing", () => {
    let s = run(initialPlayer(1), [{ type: "play" }], cfg(true));
    s = run(s, [{ type: "failed", token: s.token, error: "no voice for fr" }], cfg(true));
    expect(s).toMatchObject({ status: "error", line: 1, error: "no voice for fr" });
    // A late end of the failed line changes nothing.
    expect(run(s, [{ type: "ended", token: s.token }], cfg(true)).status).toBe("error");
    // Play tries the same line again.
    expect(run(s, [{ type: "play" }], cfg(true))).toMatchObject({ status: "speaking", line: 1 });
  });

  it("while idle, select and next only move the cursor", () => {
    const s = run(initialPlayer(1), [{ type: "select", line: 3 }, { type: "next" }]);
    expect(s).toMatchObject({ status: "idle", line: 4, token: 0 });
  });

  it("replay reads the same line again with a new token", () => {
    let s = run(initialPlayer(2), [{ type: "play" }]);
    s = run(s, [end(s), { type: "replay" }]);
    expect(s).toMatchObject({ status: "speaking", line: 2, token: 2 });
  });
});

describe("read player: helpers", () => {
  it("speechChunks: sentences, at most 200 characters each", () => {
    expect(speechChunks("Il était une fois. Un petit prince!  Fin")).toEqual([
      "Il était une fois.",
      "Un petit prince!",
      "Fin",
    ]);
    const long = Array.from({ length: 60 }, (_, i) => `mot${i}`).join(" ");
    const parts = speechChunks(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join(" ")).toBe(long);
    expect(speechChunks("   ")).toEqual([]);
    expect(speechChunks("你好。再见。")).toEqual(["你好。", "再见。"]);
  });

  it("readLang: the book's language, else a guess from the script", () => {
    expect(readLang("fr", "Le Petit Prince")).toBe("fr");
    expect(readLang("fr_FR", "")).toBe("fr-FR");
    expect(readLang(undefined, "こんにちは")).toBe("ja");
    expect(readLang(undefined, "小王子")).toBe("zh");
    expect(readLang(undefined, "Hello")).toBe("en");
  });
});
