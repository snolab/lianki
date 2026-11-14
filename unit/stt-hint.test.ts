import { afterEach, describe, expect, it } from "bun:test";
import { globalDescriptor, restoreGlobal, setGlobal } from "./support/globals";
import {
  STT_HINT_KEY,
  deviceLang,
  formatSttPrompt,
  learnSttHint,
  scriptLang,
  sttHint,
} from "@lianki/debug-chat/stt-hint";

const g = globalThis as Record<string, unknown>;
const saved = {
  localStorage: globalDescriptor("localStorage"),
  navigator: globalDescriptor("navigator"),
};
const fakeStorage = (fail = false) => {
  const m = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => {
      if (fail) throw new Error("SecurityError");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (fail) throw new Error("QuotaExceededError");
      m.set(k, v);
    },
  };
  return m;
};
const setNavigator = (v: unknown) => setGlobal("navigator", v);
afterEach(() => {
  restoreGlobal("localStorage", saved.localStorage);
  restoreGlobal("navigator", saved.navigator);
});

describe("the mic's STT hint", () => {
  it("reads a line's language by script: kana is Japanese, else Han is Chinese, else Latin", () => {
    expect(scriptLang("这个麦克风按钮")).toBe("zh");
    expect(scriptLang("用 Whisper 跑")).toBe("zh");
    expect(scriptLang("マイクを使う")).toBe("ja");
    expect(scriptLang("日本語で話す")).toBe("ja");
    expect(scriptLang("what's the name?")).toBe("en");
    expect(scriptLang("👍 1")).toBeUndefined();
  });
  it("falls back to the first device language that is zh, ja or en", () => {
    expect(deviceLang(["zh-Hans-CN", "ja-JP"])).toBe("zh");
    expect(deviceLang(["fr-FR", "ja-JP"])).toBe("ja");
    expect(deviceLang(["EN-us"])).toBe("en");
    expect(deviceLang(["fr", ""])).toBeUndefined();
  });

  it("learns from a typed line, and the stored hint wins over the device", () => {
    const m = fakeStorage();
    setNavigator({ languages: ["ja-JP"], language: "ja-JP" });
    expect(sttHint()).toBe("ja");
    learnSttHint("这个怎么用");
    expect(m.get(STT_HINT_KEY)).toBe("zh");
    expect(sttHint()).toBe("zh");
    learnSttHint("🙂"); // no script: unchanged
    expect(sttHint()).toBe("zh");
    m.set(STT_HINT_KEY, "fr"); // not a hint: the device decides
    expect(sttHint()).toBe("ja");
    setNavigator({ languages: [], language: "en-GB" });
    expect(sttHint()).toBe("en");
    setNavigator({ languages: [] });
    expect(sttHint()).toBeUndefined();
    setNavigator(undefined);
    expect(sttHint()).toBeUndefined();
  });
  it("blocked storage: no hint learnt, the device language still answers", () => {
    fakeStorage(true);
    setNavigator({ languages: ["zh-CN"] });
    learnSttHint("中文");
    expect(sttHint()).toBe("zh");
  });

  it("formatSttPrompt formats prompt with hotwords or returns base prompt", () => {
    expect(formatSttPrompt("base")).toBe("base");
    expect(formatSttPrompt("base", [])).toBe("base");
    expect(formatSttPrompt("base", ["  "])).toBe("base");
    expect(formatSttPrompt("base", ["lianki", "codex"])).toBe("base 热词: lianki, codex。");
  });
});
