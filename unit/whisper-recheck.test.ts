/**
 * Whisper re-listens to a whole continuous-speech run (whisper-recheck.ts): the
 * page's plan and amend, the wire check, the hub's apply, and the readings shown
 * in the details. Made-up lines only; nothing plays, records or reaches a Mac.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RECHECK_ENGINE,
  type RecheckConf,
  type RecheckPlan,
  applyRecheck,
  cleanRecheckAmend,
  createPassageRecheck,
  readingsOf,
  recheckAmend,
  recheckPlan,
} from "@lianki/debug-chat/whisper-recheck";
import { LineReadings } from "@lianki/debug-chat/MessageDetails";
import { MERGE_BY, splitLine } from "@lianki/debug-chat/voice-merge";
import { type ChatMessage, MAX_CHAT, applyEdit } from "@lianki/debug-chat/wire";
import { EXTRA } from "@lianki/debug-chat/chat-ui-locales";
import { parsePageMessage } from "@/lib/dev-eval";
import { FLAGS } from "@/lib/flags";
import { CONFIG } from "@/lib/config";

const CONF: RecheckConf = { on: true, minSec: 1.5, maxSec: 60, timeoutMs: 8000 };
const local = { route: "local" as const, engine: "sensevoice" };

/** A merged line of two parts, spoken from 10 000 to 14 000 on the page's clock. */
const merged = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "ab12-cd34",
  from: "owner",
  label: "/words iPhone",
  text: "那你能不能给。我一个按钮",
  raw: "那你能不能给。我一个按钮",
  at: 1,
  source: "stt",
  edited: { at: 2, by: MERGE_BY, count: 0 },
  parts: [
    {
      id: "ab12-cd34",
      text: "那你能不能给。",
      at: 1,
      stt: local,
      timing: { t_speechStart: 10_000, t_speechEnd: 11_500 },
    },
    {
      id: "ef56",
      text: "我一个按钮",
      at: 2,
      stt: local,
      timing: { t_speechStart: 12_000, t_speechEnd: 14_000 },
    },
  ],
  ...over,
});

const planOf = (line = merged(), now = 16_500): RecheckPlan => {
  const p = recheckPlan(line, now, CONF);
  if ("skip" in p) throw new Error(p.skip);
  return p;
};

const answer = (over: Record<string, unknown> = {}) => ({
  t: "recheck_result",
  rid: "r1",
  auto: true,
  run: "ab12-cd34",
  engine: "mlx-whisper",
  ok: true,
  text: " 那你能不能给我一个按钮。 ",
  lang: "zh",
  ...over,
});

describe("recheckPlan", () => {
  it("asks for the run's window as durations before now", () => {
    expect(planOf()).toEqual({
      run: "ab12-cd34",
      parts: 2,
      text: "那你能不能给。我一个按钮",
      msg: {
        t: "recheck",
        auto: true,
        engine: RECHECK_ENGINE,
        run: "ab12-cd34",
        fromAgoMs: 6500,
        toAgoMs: 2500,
      },
    });
  });

  it("skips what is not one untouched merged run from the Mac", () => {
    const skip = (line: ChatMessage | undefined, conf = CONF, now = 16_500) =>
      (recheckPlan(line, now, conf) as { skip: string }).skip;
    expect(skip(merged(), { ...CONF, on: false })).toBe("off");
    expect(skip(undefined)).toBe("no-line");
    expect(skip(merged({ parts: undefined }))).toBe("not-merged");
    expect(skip(merged({ settled: true }))).toBe("closed");
    expect(skip(merged({ collapsedInto: "x" }))).toBe("closed");
    const mark = { at: 3, engine: "mlx-whisper", heard: "a", text: "b" };
    expect(skip(merged({ recheck: mark }))).toBe("done");
    expect(skip(merged({ edited: { at: 3, by: "main", count: 1 } }))).toBe("edited");
    expect(skip(merged({ text: "polished" }))).toBe("edited");
    const cloud = merged();
    cloud.parts![1] = { ...cloud.parts![1], stt: { route: "cloud" } };
    expect(skip(cloud)).toBe("not-local");
    const untimed = merged();
    untimed.parts![0] = { ...untimed.parts![0], timing: undefined };
    expect(skip(untimed)).toBe("no-timing");
    expect(skip(merged(), CONF, 13_000)).toBe("no-timing");
    expect(skip(merged(), { ...CONF, minSec: 5 })).toBe("short");
    expect(skip(merged(), { ...CONF, maxSec: 3 })).toBe("long");
  });
});

describe("recheckAmend", () => {
  it("turns the Mac's answer into an amend of the same line", () => {
    expect(recheckAmend(planOf(), answer(), merged())).toEqual({
      id: "ab12-cd34",
      parts: 2,
      text: "那你能不能给我一个按钮。",
      engine: "mlx-whisper",
      lang: "zh",
    });
    // An odd engine name or language is not carried along.
    expect(recheckAmend(planOf(), answer({ engine: "<b>", lang: "中文" }), merged())).toEqual({
      id: "ab12-cd34",
      parts: 2,
      text: "那你能不能给我一个按钮。",
      engine: RECHECK_ENGINE,
    });
  });

  it("keeps level 1 on a failure, another run, or a line that moved on", () => {
    const p = planOf();
    expect(recheckAmend(p, undefined, merged())).toBeUndefined();
    expect(recheckAmend(p, answer({ ok: false, error: "recheck busy" }), merged())).toBeUndefined();
    expect(recheckAmend(p, answer({ auto: undefined }), merged())).toBeUndefined();
    expect(recheckAmend(p, answer({ run: "other" }), merged())).toBeUndefined();
    expect(recheckAmend(p, answer({ text: "  " }), merged())).toBeUndefined();
    expect(recheckAmend(p, answer({ text: 5 }), merged())).toBeUndefined();
    expect(recheckAmend(p, answer({ text: "x".repeat(MAX_CHAT + 1) }), merged())).toBeUndefined();
    expect(recheckAmend(p, answer(), undefined)).toBeUndefined();
    expect(recheckAmend(p, answer(), merged({ id: "zz" }))).toBeUndefined();
    expect(recheckAmend(p, answer(), merged({ settled: true }))).toBeUndefined();
    const grown = merged();
    grown.parts = [...grown.parts!, { id: "gh", text: "。", at: 3 }];
    expect(recheckAmend(p, answer(), grown)).toBeUndefined();
    expect(recheckAmend(p, answer(), merged({ text: "x", raw: "x" }))).toBeUndefined();
  });
});

describe("createPassageRecheck (the page's passage end)", () => {
  const rig = (
    o: { conf?: RecheckConf; call?: boolean; answer?: () => Promise<Record<string, unknown>> } = {},
  ) => {
    const sent: unknown[] = [];
    const asked: unknown[] = [];
    let line = merged();
    const end = createPassageRecheck({
      conf: () => ("conf" in o ? o.conf : CONF),
      recheck: () =>
        o.call === false
          ? undefined
          : (msg, ms) => (asked.push([msg, ms]), (o.answer ?? (async () => answer()))()),
      line: (id) => (id === line.id ? line : undefined),
      send: (r) => void sent.push(r),
      now: () => 16_500,
    });
    return { end, sent, asked, set: (l: ChatMessage) => (line = l), line: () => line };
  };

  it("sends the passage end with Whisper's reading", async () => {
    const r = rig();
    await r.end(r.line());
    expect(r.asked).toEqual([[planOf().msg, 8000]]);
    expect(r.sent).toEqual([
      {
        id: "ab12-cd34",
        parts: 2,
        text: "那你能不能给我一个按钮。",
        engine: "mlx-whisper",
        lang: "zh",
      },
    ]);
  });

  it("sends it at once with no reading when off, without a Mac, or for a skipped run", () => {
    for (const o of [{ conf: undefined }, { call: false }, { conf: { ...CONF, on: false } }]) {
      const r = rig(o);
      expect(r.end(r.line())).toBeUndefined();
      expect(r.sent).toEqual([undefined]);
      expect(r.asked).toEqual([]);
    }
  });

  it("keeps level 1 when the Mac fails, and asks once per run", async () => {
    let fail!: (e: Error) => void;
    const r = rig({ answer: () => new Promise((_, ko) => (fail = ko)) });
    const wait = r.end(r.line());
    expect(r.end(r.line())).toBeUndefined(); // the same run, still being read
    fail(new Error("local stt: no answer"));
    await wait;
    expect(r.sent).toEqual([undefined]);
    expect(r.asked).toHaveLength(1);
  });

  it("sends nothing when a part joined while Whisper read; the line's own check otherwise", async () => {
    let done!: (v: Record<string, unknown>) => void;
    const r = rig({ answer: () => new Promise((ok) => (done = ok)) });
    const wait = r.end(r.line());
    const grown = merged();
    grown.parts = [...grown.parts!, { id: "gh", text: "。", at: 3 }];
    r.set(grown);
    done(answer());
    await wait;
    expect(r.sent).toEqual([]);
    // Gone from the page (an undo): the passage end goes, with no reading.
    const s2 = rig({ answer: async () => answer() });
    const w2 = s2.end(s2.line());
    s2.set(merged({ id: "zz" }));
    await w2;
    expect(s2.sent).toEqual([undefined]);
  });
});

describe("the wire and the hub", () => {
  const amend = {
    id: "ab12-cd34",
    parts: 2,
    text: "那你能不能给我一个按钮。",
    engine: "mlx-whisper",
    lang: "zh",
  };

  it("checks the passage end's recheck field", () => {
    expect(cleanRecheckAmend(amend)).toEqual(amend);
    expect(cleanRecheckAmend({ ...amend, text: " a ", lang: "zzzzzzzzzzzz" })).toEqual({
      id: amend.id,
      parts: 2,
      text: "a",
      engine: "mlx-whisper",
    });
    for (const bad of [
      null,
      [],
      "x",
      { ...amend, id: "a b" },
      { ...amend, parts: 1 },
      { ...amend, parts: 2.5 },
      { ...amend, text: "" },
      { ...amend, text: "x".repeat(MAX_CHAT + 1) },
      { ...amend, engine: "" },
    ])
      expect(cleanRecheckAmend(bad)).toBeUndefined();
    expect(parsePageMessage(JSON.stringify({ type: "passage-end", recheck: amend }))).toEqual({
      type: "passage-end",
      recheck: amend,
    });
    expect(parsePageMessage(JSON.stringify({ type: "passage-end", recheck: { id: 1 } }))).toEqual({
      type: "passage-end",
    });
  });

  it("amends the stored line, keeping the streaming text", () => {
    const next = applyRecheck(merged(), amend, 99) as ChatMessage;
    expect(next.text).toBe(amend.text);
    expect(next.raw).toBe(amend.text);
    expect(next.edited).toEqual({ at: 99, by: MERGE_BY, count: 0 });
    expect(next.recheck).toEqual({
      at: 99,
      engine: "mlx-whisper",
      lang: "zh",
      heard: "那你能不能给。我一个按钮",
      text: amend.text,
    });
    expect(next.parts).toEqual(merged().parts);
    const { lang: _lang, ...noLang } = amend;
    expect((applyRecheck(merged({ edited: undefined }), noLang, 5) as ChatMessage).recheck).toEqual(
      {
        at: 5,
        engine: "mlx-whisper",
        heard: "那你能不能给。我一个按钮",
        text: amend.text,
      },
    );
    // The undo still splits it back into the parts as heard, with no reading left on them.
    const split = splitLine(next);
    expect(split.map((x) => x.text)).toEqual(["那你能不能给。", "我一个按钮"]);
    expect(split.some((x) => "recheck" in x)).toBe(false);
  });

  it("leaves a line that is not the run as it was", () => {
    expect(applyRecheck(merged({ id: "zz" }), amend, 1)).toBe("other-line");
    expect(applyRecheck(merged({ passage: { at: 1, by: "main", ids: [] } }), amend, 1)).toBe(
      "closed",
    );
    expect(applyRecheck(merged(), { ...amend, parts: 3 }, 1)).toBe("parts-changed");
    expect(applyRecheck(merged({ edited: { at: 3, by: "auto", count: 1 } }), amend, 1)).toBe(
      "edited",
    );
  });

  it("carries the reading to the pages' copy, and keeps it through a later polish", () => {
    const next = applyRecheck(merged(), amend, 99) as ChatMessage;
    const page = applyEdit(merged(), {
      id: next.id,
      thread: "owner",
      text: next.text,
      raw: next.raw!,
      edited: next.edited!,
      parts: next.parts,
      recheck: next.recheck,
    });
    expect(page.recheck).toEqual(next.recheck);
    const polished = applyEdit(page, {
      id: next.id,
      thread: "owner",
      text: "那你能不能给我一个按钮？",
      raw: next.raw!,
      edited: { at: 100, by: "auto", count: 1 },
    });
    expect(polished.recheck).toEqual(next.recheck);
  });
});

describe("the three readings in the details", () => {
  const mark = { at: 3, engine: "mlx-whisper", heard: "流失识别", text: "流式识别" };

  it("lists level 1, level 2 and a polish after it", () => {
    expect(readingsOf({ text: "a" })).toBeUndefined();
    expect(
      readingsOf({ text: "流式识别", recheck: mark, edited: { at: 3, by: MERGE_BY, count: 0 } }),
    ).toEqual({
      heard: "流失识别",
      whisper: { text: "流式识别", engine: "mlx-whisper" },
    });
    const polished = { text: "流式识别。", recheck: mark, edited: { at: 4, by: "auto", count: 1 } };
    expect(readingsOf(polished)?.polished).toBe("流式识别。");
    expect(readingsOf({ ...polished, text: "流式识别" })?.polished).toBeUndefined();
  });

  it("draws them under their labels, in every locale", () => {
    const words = EXTRA.zh;
    const html = renderToStaticMarkup(
      createElement(LineReadings, {
        line: { text: "流式识别。", recheck: mark, edited: { at: 4, by: "auto", count: 1 } },
        words,
      }),
    );
    expect(html).toContain('data-level="heard"');
    expect(html).toContain("整段重听（mlx-whisper）");
    expect(html).toContain('data-level="polished"');
    expect(renderToStaticMarkup(createElement(LineReadings, { line: { text: "a" }, words }))).toBe(
      "",
    );
    for (const extra of Object.values(EXTRA)) {
      expect(extra.levelHeard.trim()).not.toBe("");
      expect(extra.levelWhisper).toContain("{engine}");
      expect(extra.levelPolished.trim()).not.toBe("");
    }
  });
});

describe("flag and config", () => {
  it("ships on, for the owner, in the stt group", () => {
    const f = FLAGS["stt.whisper-recheck"];
    expect(f.default).toBe(true);
    expect(f.audience).toBe("owner");
    expect(f.group).toBe("stt");
  });

  it("has its defaults in lib/config.ts", () => {
    expect(CONFIG["stt.recheckMinSec"].default).toBe(1.5);
    expect(CONFIG["stt.recheckMaxSec"].default).toBe(60);
    expect(CONFIG["stt.recheckTimeoutMs"].default).toBe(8000);
  });
});
