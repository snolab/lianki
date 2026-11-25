import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_LOCAL_TTS_FALLBACKS,
  localTtsFallback,
  setLocalTtsFallbacks,
} from "@lianki/debug-chat/local-tts-fallback";

afterEach(() => setLocalTtsFallbacks({}));

describe("local TTS after cloud retirement", () => {
  it("keeps local-network requests off until the account and service opt in", () => {
    expect(localTtsFallback("zh", "sweet", true)).toBeUndefined();
    setLocalTtsFallbacks(DEFAULT_LOCAL_TTS_FALLBACKS);
    expect(localTtsFallback("zh", "sweet", false)).toBeUndefined();
    expect(localTtsFallback("zh", "sweet", true)).toBe("xiaobei");
  });

  it("resolves locale data and keeps different lanes in different voices", () => {
    setLocalTtsFallbacks(DEFAULT_LOCAL_TTS_FALLBACKS);
    expect(localTtsFallback("zh-TW", "sweet", true)).toBe("xiaobei");
    expect(localTtsFallback("zh", "calm", true)).toBe("yunxi");
    expect(localTtsFallback("zh", "main", true)).toBe("xiaoxiao");
    expect(localTtsFallback("fr", "sweet", true)).toBeUndefined();
    expect(localTtsFallback("en", "sweet", true)).toBeUndefined();
  });

  it("a live configuration can disable or replace the fallback without storage writes", () => {
    setLocalTtsFallbacks({ "zh-HK": { main: "xiaobei" } });
    expect(localTtsFallback("zh", "sweet", true)).toBeUndefined();
    expect(localTtsFallback("zh-HK", "sweet", true)).toBe("xiaobei");
    setLocalTtsFallbacks({ zh: { main: "xiaobei" } });
    expect(localTtsFallback("zh-CN", "sweet", true)).toBe("xiaobei");
    setLocalTtsFallbacks({});
    expect(localTtsFallback("fr", "sweet", true)).toBeUndefined();
  });
});
