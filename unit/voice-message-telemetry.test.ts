import { describe, expect, it } from "bun:test";
import { createVoice, type UtterLike } from "../packages/debug-chat/src/voice";

function harness() {
  const utterances: UtterLike[] = [];
  const events: [string, string][] = [];
  const v = createVoice({
    synth: () => ({ speak: (u) => void utterances.push(u), cancel: () => {} }),
    utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
    here: () => true,
    enabled: () => true,
    speechMetric: (id, status) => void events.push([id, status]),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const start = () => utterances.at(-1)?.onstart?.();
  const end = () => utterances.at(-1)?.onend?.();
  const fail = (error?: string) => utterances.at(-1)?.onerror?.(error ? { error } : undefined);
  return { v, events, start, end, fail };
}

describe("voice message telemetry", () => {
  it("waits for real playback start and the last sentence's natural end", () => {
    const h = harness();
    h.v.reply("First sentence. Second sentence.", { id: "line-1" });
    expect(h.events).toEqual([]);
    h.start();
    h.end();
    expect(h.events).toEqual([["line-1", "start"]]);
    h.start();
    h.end();
    expect(h.events).toEqual([
      ["line-1", "start"],
      ["line-1", "start"],
      ["line-1", "end"],
    ]);
  });

  it("does not call a later successful chunk a complete message after a failed chunk", () => {
    const h = harness();
    h.v.reply("Failed sentence. Successful sentence.", { id: "line-2" });
    h.start();
    h.fail();
    h.start();
    h.end();
    expect(h.events).toEqual([
      ["line-2", "start"],
      ["line-2", "error"],
      ["line-2", "start"],
    ]);
  });

  it("keeps a pause resumable without reporting it as finished or cancelled", () => {
    const h = harness();
    h.v.reply("A sentence to pause.", { id: "line-3" });
    h.start();
    h.v.interrupt("typing");
    expect(h.events).toEqual([["line-3", "start"]]);
    h.v.resume();
    h.start();
    h.end();
    expect(h.events.at(-1)).toEqual(["line-3", "end"]);
  });

  it("does not turn browser refusal into completion while waiting for a tap", () => {
    const h = harness();
    h.v.reply("Waiting for permission to play.", { id: "line-blocked" });
    h.fail("not-allowed");
    expect(h.events).toEqual([]);
    h.v.unblock();
    h.start();
    h.end();
    expect(h.events).toEqual([
      ["line-blocked", "start"],
      ["line-blocked", "end"],
    ]);
  });

  it("reports explicit stopping and queued drops as cancelled", () => {
    const h = harness();
    h.v.reply("Playing now.", { id: "line-4" });
    h.v.reply("Queued after that.", { id: "line-5" });
    h.v.drop("line-5");
    h.start();
    h.v.stop();
    expect(h.events).toEqual([
      ["line-5", "cancel"],
      ["line-4", "start"],
      ["line-4", "cancel"],
    ]);
  });

  it("cancels superseded reading instead of reporting a natural completion", () => {
    const h = harness();
    h.v.reply("Old pending text.", { id: "line-6", lane: "codex" });
    h.start();
    h.v.reply(
      "New replacement.",
      { id: "line-7", lane: "codex", cut: "supersede" },
      { live: true },
    );
    expect(h.events).toContainEqual(["line-6", "cancel"]);
    h.start();
    h.end();
    expect(h.events.at(-1)).toEqual(["line-7", "end"]);
    expect(h.events).not.toContainEqual(["line-6", "end"]);
  });
});
