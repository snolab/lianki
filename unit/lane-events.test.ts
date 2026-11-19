// packages/debug-chat/src/lane-events.ts: the chat's system lines about its
// lanes, in 16 locales with a context line per key (docs/i18n.md).
import { describe, expect, it } from "bun:test";
import {
  LANE_EVENT_CONTEXT,
  LANE_EVENT_KINDS,
  LANE_EVENT_STRINGS,
  isLaneEventKind,
  laneEventText,
  laneModeWord,
  isLaneScope,
  listeningEvent,
  scopeRank,
  wideScope,
  widerScope,
  parseLaneEvent,
  tokensNeededText,
  withLaneEvent,
} from "@/packages/debug-chat/src/lane-events";
import { CHAT_LOCALES } from "@/packages/debug-chat/src/chat-ui-locales";

describe("lane event strings", () => {
  it("every locale has every key, each keeps its placeholder; every key has its context", () => {
    const keys = Object.keys(LANE_EVENT_CONTEXT).sort();
    for (const l of CHAT_LOCALES) {
      const t = LANE_EVENT_STRINGS[l];
      expect(Object.keys(t).sort()).toEqual(keys);
      for (const k of LANE_EVENT_KINDS) expect(t[k]).toContain("{name}");
      expect(t.tokensNeeded).toContain("{names}");
      for (const v of Object.values(t)) expect(v.trim().length).toBeGreaterThan(0);
    }
    // A context line says where, what and how: more than a few words, not the English again.
    for (const [k, line] of Object.entries(LANE_EVENT_CONTEXT)) {
      expect(line.split(/\s+/).length).toBeGreaterThan(10);
      expect(line).not.toBe(LANE_EVENT_STRINGS.en[k as keyof typeof LANE_EVENT_CONTEXT]);
    }
  });
  it("text in a locale, English for an unknown one", () => {
    expect(laneEventText({ kind: "left", name: "杰咪" }, "zh")).toBe("杰咪 下线");
    expect(laneEventText({ kind: "joined", name: "coco" }, "ja")).toBe(
      "coco が参加しました（閲覧のみ）",
    );
    expect(laneEventText({ kind: "reader", name: "x" }, "xx")).toBe("x switched to read-only");
    expect(tokensNeededText(["a", "b"], "zh")).toBe(
      "还在等 token 才能入群：a, b（偏好设置 → API tokens）",
    );
  });
  it("the mode word: muted first, then the mode, else none", () => {
    expect(laneModeWord({ mode: "listener" }, "zh")).toBe("实时监听");
    expect(laneModeWord({ mode: "listener", scope: "all" }, "zh")).toBe("实时监听（全部消息）");
    expect(laneModeWord({ mode: "listener", scope: "owner" }, "en")).toBe("listening live");
    expect(laneModeWord({ mode: "reader", scope: "all" }, "en")).toBe("read-only");
    expect(laneEventText({ kind: "listeningAll", name: "小克" }, "zh")).toBe(
      "小克 开始实时监听（全部消息）",
    );
    expect(laneEventText({ kind: "listening", name: "小克" }, "zh")).toBe("小克 开始实时监听");
    expect(isLaneScope("all")).toBe(true);
    expect(isLaneScope("owner")).toBe(true);
    expect(isLaneScope("x")).toBe(false);
    // Tier ⓪ (owner, 2026-11-16 02:16 JST): all messages and the system notices.
    expect(isLaneScope("system")).toBe(true);
    expect(isLaneScope(3)).toBe(false);
    expect(laneModeWord({ mode: "listener", scope: "system" }, "zh")).toBe(
      "实时监听（全部消息 + 系统通知）",
    );
    expect(laneModeWord({ mode: "listener", scope: "system" }, "en")).toBe(
      "listening live (all messages + system notices)",
    );
    expect(laneEventText({ kind: "listeningSystem", name: "小克" }, "zh")).toBe(
      "小克 开始实时监听（全部消息 + 系统通知）",
    );
    expect([scopeRank("owner"), scopeRank("all"), scopeRank("system"), scopeRank("x")]).toEqual([
      0, 1, 2, 0,
    ]);
    expect(widerScope("owner", "all")).toBe("all");
    expect(widerScope("system", "all")).toBe("system");
    expect(widerScope("all", "all")).toBe("all");
    expect([wideScope("owner"), wideScope("all"), wideScope("system"), wideScope(1)]).toEqual([
      undefined,
      "all",
      "system",
      undefined,
    ]);
    expect([listeningEvent(undefined), listeningEvent("all"), listeningEvent("system")]).toEqual([
      "listening",
      "listeningAll",
      "listeningSystem",
    ]);
    expect(laneModeWord({ mode: "reader" }, "en")).toBe("read-only");
    expect(laneModeWord({ mode: "listener", muted: true }, "en")).toBe("muted");
    expect(laneModeWord({}, "en")).toBeNull();
  });
  it("parse and show a line's event in the page's language", () => {
    expect(isLaneEventKind("joined")).toBe(true);
    expect(isLaneEventKind("boss")).toBe(false);
    expect(parseLaneEvent(null)).toBeNull();
    expect(parseLaneEvent({ lane: "a", name: "a", kind: "x" })).toBeNull();
    expect(parseLaneEvent({ lane: "a", name: 1, kind: "left" })).toBeNull();
    const m = {
      id: "1",
      text: "coco 开始实时监听",
      laneEvent: { lane: "codex", name: "coco", kind: "listening" },
    };
    expect(withLaneEvent(m, "en").text).toBe("coco is now listening live");
    expect(withLaneEvent(m, "zh")).toBe(m);
    const plain = { id: "2", text: "hi" };
    expect(withLaneEvent(plain, "en")).toBe(plain);
    const broken = { id: "3", text: "x", laneEvent: { kind: "nope" } };
    expect(withLaneEvent(broken, "en")).toBe(broken);
  });
});
