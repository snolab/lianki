import { describe, expect, it } from "bun:test";
import {
  CHAT_LOCALES,
  EXTRA,
  EXTRA_CONTEXT,
  LEGACY_CONTEXT,
  LEGACY_KEYS,
  OTHER_LEGACY,
  chatExtra,
  chatLocale,
} from "@lianki/debug-chat/chat-ui-locales";
import { UI_EN, uiStrings } from "@lianki/debug-chat/ui-strings";

const placeholders = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();

// The Learning Partner chat in the app's 16 locales (docs/i18n.md).
describe("chat strings in 16 locales", () => {
  it("maps page languages to app locales", () => {
    expect(chatLocale("pt-BR")).toBe("pt");
    expect(chatLocale("zh_TW")).toBe("zh");
    expect(chatLocale("tr")).toBe("en");
    expect(chatLocale("")).toBe("en");
    expect(chatLocale(null)).toBe("en");
    expect(CHAT_LOCALES.length).toBe(16);
  });

  it("every locale has every string, with the English placeholders", () => {
    for (const l of CHAT_LOCALES) {
      for (const k of Object.keys(EXTRA.en) as (keyof typeof EXTRA.en)[]) {
        expect(EXTRA[l][k], `${l}.${k}`).toBeTruthy();
        expect(placeholders(EXTRA[l][k]), `${l}.${k}`).toEqual(placeholders(EXTRA.en[k]));
      }
    }
    for (const [l, table] of Object.entries(OTHER_LEGACY)) {
      for (const k of LEGACY_KEYS) {
        expect(table[k], `${l}.${k}`).toBeTruthy();
        expect(placeholders(table[k]), `${l}.${k}`).toEqual(placeholders(UI_EN[k]));
      }
    }
  });

  it("every string has a context line", () => {
    for (const k of LEGACY_KEYS) expect(LEGACY_CONTEXT[k].split(" ").length).toBeGreaterThan(5);
    for (const k of Object.keys(EXTRA.en) as (keyof typeof EXTRA.en)[])
      expect(EXTRA_CONTEXT[k].split(" ").length).toBeGreaterThan(5);
  });

  it("uiStrings gives other locales their user-facing strings over English", () => {
    const de = uiStrings("de-DE");
    expect(de.fullScreen).toBe("Vollbild");
    expect(de.latency).toBe(UI_EN.latency); // developer-only: English
    expect(uiStrings("en")).toBe(UI_EN);
    expect(chatExtra("ko").minimize).toBe("최소화");
  });
});
