import { describe, expect, test } from "bun:test";
import { browserVoiceFor } from "@/lib/words/browser-voice";

const v = (
  lang: string,
  name: string,
  extra: { voiceURI?: string; localService?: boolean } = {},
) => ({
  lang,
  name,
  voiceURI: extra.voiceURI ?? `com.apple.voice.compact.${lang}.${name}`,
  localService: extra.localService,
});

describe("browserVoiceFor: a voice of the part's own language only", () => {
  const voices = [
    v("en-US", "Samantha"),
    v("zh-TW", "Meijia"),
    v("zh-CN", "Tingting"),
    v("ja-JP", "Kyoko"),
    v("fr_CA", "Amelie"),
  ];

  test("the language's own region first", () => {
    expect(browserVoiceFor(voices, "zh")?.name).toBe("Tingting");
    expect(browserVoiceFor(voices, "ja")?.name).toBe("Kyoko");
    expect(browserVoiceFor(voices, "en")?.name).toBe("Samantha");
  });

  test("another region of the language when its own is missing; Android's fr_CA tag", () => {
    expect(browserVoiceFor(voices, "fr")?.name).toBe("Amelie");
    expect(browserVoiceFor(voices, "zh-TW")?.name).toBe("Meijia");
  });

  test("no voice of the language: null, never another language's voice", () => {
    expect(browserVoiceFor(voices, "ko")).toBeNull();
    expect(browserVoiceFor([], "zh")).toBeNull();
  });

  test("natural voices before robotic ones; a local one among equals", () => {
    const pool = [
      v("zh-CN", "Eddy", { voiceURI: "com.apple.eloquence.zh-CN.Eddy" }),
      v("zh-CN", "Remote", { voiceURI: "remote-zh" }),
      v("zh-CN", "Local", { voiceURI: "local-zh", localService: true }),
      v("zh-CN", "Lili", { voiceURI: "com.apple.voice.premium.zh-CN.Lili" }),
    ];
    expect(browserVoiceFor(pool, "zh")?.name).toBe("Lili");
    expect(browserVoiceFor(pool.slice(0, 3), "zh")?.name).toBe("Local");
  });
});
