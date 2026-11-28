import { expect, test } from "bun:test";
import dictionary from "../app/(app)/dev/live-audio/live-audio.content";
import { keyContext } from "../lib/i18n-context";
import { DEV_PAGE_PERMISSION } from "../lib/dev-page-permissions";
const locales = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
].sort();
test("Live PCM panel labels carry their whole local-only context in all16locales", () => {
  const context = keyContext(dictionary.description);
  expect(Object.keys(dictionary.content).length).toBe(38);
  for (const [key, value] of Object.entries(dictionary.content)) {
    const translation = (value as { translation: Record<string, string> }).translation;
    expect(Object.keys(translation).sort()).toEqual(locales);
    for (const locale of locales) expect(translation[locale]?.trim().length).toBeGreaterThan(0);
    expect(context[key]).toContain("Same-machine");
    expect(context[key]).toContain("No automatic microphone or playback");
  }
  expect(DEV_PAGE_PERMISSION["live-audio"]).toBe("dev");
});
