import { expect, test } from "bun:test";
import {
  PILL_UI_LANGUAGE_KEY,
  portableUiLocale,
  readPortableUiLanguage,
  rememberPortableUiLanguage,
} from "../src/pill-chat-language";
const setup = () => {
  const values = new Map<string, unknown>();
  const writes: string[] = [];
  return {
    values,
    writes,
    gm: {
      getValue: (k: string) => values.get(k),
      setValue: (k: string, v: unknown) => {
        values.set(k, v);
        writes.push(k);
      },
    },
  };
};
test("the Lianki interface language wins over browser and foreign-site language", () => {
  const { gm, writes } = setup();
  expect(readPortableUiLanguage(gm, "fr-FR")).toBe("fr");
  expect(rememberPortableUiLanguage(gm, "https://lianki.com", "zh-CN", true)).toBe(true);
  expect(readPortableUiLanguage(gm, "fr-FR")).toBe("zh");
  expect(rememberPortableUiLanguage(gm, "https://zhihu.com", "fr", true)).toBe(false);
  expect(readPortableUiLanguage(gm, "fr-FR")).toBe("zh");
  expect(writes).toEqual([PILL_UI_LANGUAGE_KEY]);
});
test("only top-level trusted UI origins publish a supported language", () => {
  const { gm, writes } = setup();
  for (const origin of ["https://lianki.com.evil.test", "http://lianki.com", "https://other.test"])
    expect(rememberPortableUiLanguage(gm, origin, "zh", true)).toBe(false);
  expect(rememberPortableUiLanguage(gm, "https://lianki.com", "zh", false)).toBe(false);
  expect(rememberPortableUiLanguage(gm, "https://lianki.com", "", true)).toBe(false);
  expect(rememberPortableUiLanguage(gm, "https://preview.lianki.com", "ja", true)).toBe(true);
  expect(rememberPortableUiLanguage(gm, "https://www.lianki.com", "ja", true)).toBe(true);
  expect(writes).toEqual([PILL_UI_LANGUAGE_KEY]);
});
test("malformed stored values fail to the browser language rather than arbitrary strings", () => {
  const { gm, values } = setup();
  values.set(PILL_UI_LANGUAGE_KEY, { locale: "zh" });
  expect(readPortableUiLanguage(gm, "de")).toBe("de");
  expect(portableUiLocale("javascript:alert(1)")).toBeNull();
  expect(portableUiLocale(null)).toBeNull();
  expect(readPortableUiLanguage(gm, "not-a-locale")).toBe("en");
});
