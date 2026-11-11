/**
 * Which recognizer made a voice line (wire.ts SttTag): set by the page from
 * what answered (local, cloud, or cloud as a fallback), parsed on the hub,
 * printed by `eval.ts chat`, and shown in the chat to dev holders only.
 */
import { describe, expect, it } from "bun:test";
import { createLatency } from "@lianki/debug-chat/latency";
import { mergeLines, splitLine } from "@lianki/debug-chat/voice-merge";
import { UI_EN } from "@lianki/debug-chat/ui-strings";
import { type ChatMessage, cleanStt, sttTagOf, sttTagText } from "@lianki/debug-chat/wire";
import { parsePageMessage } from "@/lib/dev-eval";
import { chatLine } from "@/scripts/dev/node-args";

describe("sttTagOf: from what actually answered", () => {
  it("local: the server's model, without the local: prefix", () => {
    expect(sttTagOf("local", "local:sensevoice-small-2024-07-17-int8")).toEqual({
      route: "local",
      engine: "sensevoice-small-2024-07-17-int8",
    });
    // A final that named no model: the route alone.
    expect(sttTagOf("local", "local:?")).toEqual({ route: "local" });
  });

  it("cloud: the route's model; a fallback is marked", () => {
    expect(sttTagOf("cloud", "@cf/openai/whisper-large-v3-turbo")).toEqual({
      route: "cloud",
      engine: "@cf/openai/whisper-large-v3-turbo",
    });
    expect(sttTagOf("cloud", "@cf/openai/whisper", true)).toEqual({
      route: "cloud",
      engine: "@cf/openai/whisper",
      fallback: true,
    });
  });
});

describe("cleanStt", () => {
  it("keeps known keys only, each checked", () => {
    expect(cleanStt({ route: "local", engine: "sensevoice-small", extra: 1 })).toEqual({
      route: "local",
      engine: "sensevoice-small",
    });
    expect(cleanStt({ route: "cloud", engine: "has spaces <b>" })).toEqual({ route: "cloud" });
    expect(cleanStt({ route: "elsewhere" })).toBeUndefined();
    expect(cleanStt("local")).toBeUndefined();
    expect(cleanStt([])).toBeUndefined();
    // Only the cloud can be a fallback.
    expect(cleanStt({ route: "local", fallback: true })).toEqual({ route: "local" });
    expect(cleanStt({ route: "cloud", fallback: "yes" })).toEqual({ route: "cloud" });
  });
});

describe("the page's latency store carries the tag beside the timing", () => {
  it("takeLine returns the utterance's stt; take stays timing only", () => {
    let t = 1000;
    const lat = createLatency({ now: () => t });
    lat.mark(1, { t_speechEnd: 900, audioMs: 500 });
    lat.mark(1, { stt: { route: "cloud", engine: "@cf/openai/whisper", fallback: true } });
    lat.mark(1, { t_sttDone: 990 });
    t = 1010;
    const got = lat.takeLine();
    expect(got.stt).toEqual({ route: "cloud", engine: "@cf/openai/whisper", fallback: true });
    expect(got.timing).not.toHaveProperty("stt");
    expect(got.timing?.t_sent).toBe(1010);
    lat.mark(2, { t_speechEnd: 1100 });
    lat.mark(2, { t_sttDone: 1150 });
    expect(lat.take()).not.toHaveProperty("stt");
    expect(lat.takeLine()).toEqual({});
  });
});

describe("the wire: page → hub → listener", () => {
  it("parsePageMessage keeps stt on a voice line only", () => {
    const stt = { route: "local", engine: "sensevoice-small" };
    const voice = parsePageMessage(
      JSON.stringify({ type: "chat", id: "a", text: "hi", source: "stt", stt }),
    );
    expect(voice).toMatchObject({ stt });
    const typed = parsePageMessage(JSON.stringify({ type: "chat", id: "b", text: "hi", stt }));
    expect(typed).not.toHaveProperty("stt");
  });

  it("eval.ts chat prints it (never anything else from it)", () => {
    const stt = { route: "cloud", engine: "@cf/openai/whisper-large-v3-turbo" };
    const line = chatLine(
      { id: "x", from: "owner", text: "hi", at: 1, label: "p", source: "stt", stt },
      {},
      false,
    );
    expect(line).toMatchObject({ source: "stt", stt });
    expect(chatLine({ id: "y", from: "owner", text: "hi", at: 1 }, {}, false)).not.toHaveProperty(
      "stt",
    );
  });

  it("a merge keeps each part's tag and the latest on the line; undo gives them back", () => {
    const local = { route: "local" as const, engine: "sensevoice-small" };
    const cloud = {
      route: "cloud" as const,
      engine: "@cf/openai/whisper",
      fallback: true as const,
    };
    const prev: ChatMessage = {
      id: "a",
      from: "owner",
      text: "first,",
      at: 1,
      source: "stt",
      mergeable: true,
      stt: local,
    } as ChatMessage;
    const m = mergeLines(prev, { id: "b", at: 2, text: "second.", stt: cloud }, 2);
    expect(m.stt).toEqual(cloud);
    expect(m.parts?.map((p) => p.stt)).toEqual([local, cloud]);
    expect(splitLine(m).map((l) => l.stt)).toEqual([local, cloud]);
  });
});

describe("the chat shows it to dev holders only", () => {
  const local = { route: "local" as const, engine: "sensevoice-small-2024-07-17-int8" };
  it("dev: where, the engine, and the fallback mark", () => {
    expect(sttTagText(local, true, UI_EN)).toBe("local · sensevoice-small-2024-07-17-int8");
    expect(
      sttTagText(
        { route: "cloud", engine: "@cf/openai/whisper-large-v3-turbo", fallback: true },
        true,
        UI_EN,
      ),
    ).toBe("cloud · whisper-large-v3-turbo · fallback");
  });
  it("not dev (friends, normal users): nothing", () => {
    expect(sttTagText(local, false, UI_EN)).toBeUndefined();
    expect(sttTagText(undefined, true, UI_EN)).toBeUndefined();
  });
});
