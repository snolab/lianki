import { describe, expect, it } from "bun:test";
import { type UtterLike, createVoice, cutOf, gateVoice, speakerOf } from "@lianki/debug-chat/voice";
import { initialRead, readStep } from "@lianki/debug-chat/read-progress";
import { silenceFor } from "@lianki/debug-chat/speak-rules";

/** speechSynthesis in memory, as in voice-session.test.ts: the mic on, so every reply is read. */
function harness() {
  const spoken: UtterLike[] = [];
  let cancels = 0;
  const v = createVoice({
    synth: () => ({
      speak: (u) => void spoken.push(u),
      cancel: () => void cancels++,
    }),
    utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
    enabled: () => true,
    here: () => true,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  v.setMic(true);
  const texts = () => spoken.map((u) => u.text);
  /** The sentence playing ends. */
  const end = () => spoken.at(-1)?.onend?.();
  const drops: string[][] = [];
  const jumps: { id: string; n: number; at: number }[] = [];
  v.onDrop((ids) => void drops.push(ids));
  v.onInterject((j) => void jumps.push(j));
  return { v, spoken, texts, end, drops, jumps, cancels: () => cancels };
}

const line = (id: string, lane: string, extra: Record<string, unknown> = {}) => ({
  id,
  lane,
  ...extra,
});
const LIVE = { live: true };

describe("say --supersede: the same lane's reading is cut", () => {
  it("stops the same lane's sentence being read, drops its unread ones, reads the new line next", () => {
    const h = harness();
    h.v.reply("Codex one. Codex two.", line("c1", "codex"), LIVE);
    h.v.reply("Codex three.", line("c2", "codex"), LIVE);
    expect(h.texts()).toEqual(["Codex one."]);
    expect(h.v.state().queued).toBe(3);
    h.v.reply("Forget that.", line("c3", "codex", { cut: "supersede" }), LIVE);
    // The one being read was cancelled, and the new line is read at once.
    expect(h.cancels()).toBe(1);
    expect(h.texts()).toEqual(["Codex one.", "Forget that."]);
    expect(h.v.state().queued).toBe(1);
    expect(h.drops).toEqual([["c2", "c1"]]);
    // The cancelled utterance's late end moves nothing.
    h.spoken[0]!.onend?.();
    expect(h.v.state().queued).toBe(1);
  });

  it("keeps other lanes' lines, and the one of another lane being read goes on", () => {
    const h = harness();
    h.v.reply("Agy reading.", line("a1", "agy"), LIVE);
    h.v.reply("Codex old.", line("c1", "codex"), LIVE);
    h.v.reply("Agy later.", line("a2", "agy"), LIVE);
    h.v.reply("Codex new.", line("c2", "codex", { cut: "supersede" }), LIVE);
    expect(h.cancels()).toBe(0);
    expect(h.drops).toEqual([["c1"]]);
    h.end();
    h.end();
    h.end();
    expect(h.texts()).toEqual(["Agy reading.", "Agy later.", "Codex new."]);
  });

  it("a line already fully read is untouched; history never cuts", () => {
    const h = harness();
    h.v.reply("Codex done.", line("c1", "codex"), LIVE);
    h.end();
    h.v.reply("Codex queued.", line("c2", "codex"), LIVE);
    // From history (or a resume): no `live`, so it is queued like any line.
    h.v.reply("From history.", line("c3", "codex", { cut: "supersede" }));
    expect(h.drops).toEqual([]);
    h.end();
    h.end();
    expect(h.texts()).toEqual(["Codex done.", "Codex queued.", "From history."]);
  });

  it("a quiet superseding line cuts the lane's reading through the gate but reads nothing", () => {
    const h = harness();
    gateVoice(h.v, (m) => silenceFor(m, { hidden: false }));
    h.v.reply("Codex old.", line("c1", "codex"), LIVE);
    h.v.reply("Agy keeps.", line("a1", "agy"), LIVE);
    h.v.reply("fyi", line("c2", "codex", { cut: "supersede", quiet: true }), LIVE);
    expect(h.cancels()).toBe(1);
    expect(h.texts()).toEqual(["Codex old.", "Agy keeps."]);
    expect(h.v.state().queued).toBe(1);
  });
});

describe("say --interject: read next, then the paused line goes on", () => {
  it("pauses the sentence being read (any lane), reads the new line, then resumes it; nothing is dropped", () => {
    const h = harness();
    h.v.reply("Agy first. Agy second.", line("a1", "agy"), LIVE);
    h.v.reply("Codex queued.", line("c1", "codex"), LIVE);
    h.v.reply("Urgent!", line("m1", "main", { cut: "interject" }), LIVE);
    expect(h.cancels()).toBe(1);
    expect(h.texts()).toEqual(["Agy first.", "Urgent!"]);
    expect(h.jumps).toEqual([{ id: "m1", n: 1, at: 0 }]);
    h.end();
    h.end();
    h.end();
    h.end();
    // The paused sentence is read again from where it stopped (its start here: no boundary heard).
    expect(h.texts()).toEqual([
      "Agy first.",
      "Urgent!",
      "Agy first.",
      "Agy second.",
      "Codex queued.",
    ]);
    expect(h.drops).toEqual([]);
  });

  it("interjections in a row are read in arrival order before the paused line", () => {
    const h = harness();
    h.v.reply("Long reply.", line("a1", "agy"), LIVE);
    h.v.reply("One.", line("x1", "codex", { cut: "interject" }), LIVE);
    h.v.reply("Two.", line("x2", "main", { cut: "interject" }), LIVE);
    // The second does not cut the first: it waits behind it.
    expect(h.cancels()).toBe(1);
    expect(h.jumps.map((j) => j.at)).toEqual([0, 1]);
    h.end();
    h.end();
    h.end();
    expect(h.texts()).toEqual(["Long reply.", "One.", "Two.", "Long reply."]);
  });

  it("with nothing being read it is a plain line; from history it never jumps ahead", () => {
    const h = harness();
    h.v.reply("Alone.", line("x1", "codex", { cut: "interject" }), LIVE);
    expect(h.texts()).toEqual(["Alone."]);
    h.v.reply("Next.", line("a1", "agy"), LIVE);
    h.v.reply("Old.", line("x2", "codex", { cut: "interject" }));
    expect(h.jumps).toEqual([]);
    h.end();
    h.end();
    expect(h.texts()).toEqual(["Alone.", "Next.", "Old."]);
  });
});

describe("cut-in helpers", () => {
  it("cutOf: only live lines, only the two modes", () => {
    expect(cutOf({ cut: "supersede" }, LIVE)).toBe("supersede");
    expect(cutOf({ cut: "interject" }, LIVE)).toBe("interject");
    expect(cutOf({ cut: "supersede" })).toBeNull();
    expect(cutOf({ cut: "other" }, LIVE)).toBeNull();
    expect(cutOf({ cut: true }, LIVE)).toBeNull();
  });
  it("speakerOf: the lane, else the token's name, else the agent id, else main", () => {
    expect(speakerOf({ lane: "codex" }, "x")).toBe("lane:codex");
    expect(speakerOf({}, "【agy】x")).toBe("lane:agy");
    expect(speakerOf({ tokenLane: "bot" }, "【bot】x")).toBe("token:bot");
    expect(speakerOf({ agentId: "pf" }, "x")).toBe("agent:pf");
    expect(speakerOf({}, "x")).toBe("lane:main");
  });
  it("read-progress insert puts an interjection at the session's place and counts it", () => {
    let p = initialRead();
    p = readStep(p, { type: "queued", n: 2 });
    p = readStep(p, { type: "enqueue", id: "a", n: 2 });
    p = readStep(p, { type: "insert", id: "x", n: 1, at: 0 });
    expect(p.queue.map((e) => e.id)).toEqual(["x", "a", "a"]);
    // The session's count that follows matches: nothing unmatched.
    p = readStep(p, { type: "queued", n: 3 });
    expect(p.unmatched).toBe(0);
    p = readStep(p, { type: "queued", n: 2 });
    expect(p.done).toEqual({ x: 1 });
  });
});
