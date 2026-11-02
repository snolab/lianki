/**
 * The wordmark (lib/brand.ts, app/components/BrandName.tsx): 鏈記 (lianki.com)
 * in Chinese, Japanese and Korean; Lianki.com in every other locale.
 */
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import config from "@/intlayer.config";
import { BrandName } from "@/app/components/BrandName";
import { BRAND_DOMAIN, cjkWordmark, wordmarkText } from "@/lib/brand";
import { ISLAND_VERSIONS } from "@/lib/islands/contract";

const LOCALES = config.internationalization!.locales! as string[];
const CJK = ["zh", "ja", "ko"];

/** The text a reader sees: tags stripped. */
const shown = (locale: string | undefined, appName = "Lianki") =>
  renderToStaticMarkup(createElement(BrandName, { appName, locale })).replace(/<[^>]+>/g, "");

test("16 locales, three of them CJK", () => {
  expect(LOCALES.length).toBe(16);
  for (const l of CJK) expect(LOCALES).toContain(l);
});

test("CJK locales: 鏈記 (lianki.com)", () => {
  for (const l of CJK) {
    expect(cjkWordmark(l)).toBe("鏈記");
    expect(wordmarkText(l)).toBe("鏈記 (lianki.com)");
    expect(shown(l)).toBe("鏈記(lianki.com)");
  }
  expect(BRAND_DOMAIN).toBe("lianki.com");
});

test("every other locale: Lianki.com", () => {
  for (const l of LOCALES.filter((x) => !CJK.includes(x))) {
    expect(cjkWordmark(l)).toBe(null);
    expect(wordmarkText(l)).toBe("Lianki.com");
    expect(shown(l)).toBe("Lianki.com");
  }
  expect(shown(undefined)).toBe("Lianki.com");
});

test("a localized app name is the tooltip, never the wordmark", () => {
  const ru = renderToStaticMarkup(createElement(BrandName, { appName: "Лианки", locale: "ru" }));
  expect(ru).toContain('title="Лианки"');
  expect(shown("ru", "Лианки")).toBe("Lianki.com");
  const en = renderToStaticMarkup(createElement(BrandName, { appName: "Lianki", locale: "en" }));
  expect(en).not.toContain("title=");
  // The landing page's zh appName (炼記) does not replace the wordmark.
  expect(shown("zh", "炼記")).toBe("鏈記(lianki.com)");
});

test("header.brand takes locale: contract version 2", () => {
  expect(ISLAND_VERSIONS["header.brand"]).toBe(2);
});
