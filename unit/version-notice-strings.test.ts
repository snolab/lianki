import { describe, expect, it } from "bun:test";
import {
  VERSION_NOTICE_LOCALES,
  VERSION_NOTICE_STRINGS,
  versionNoticeStrings,
} from "@/app/components/version-notice-strings";

describe("versionNoticeStrings", () => {
  it("picks the page's language by its base tag", () => {
    expect(versionNoticeStrings("zh-CN").refresh).toBe("有新版本 · 刷新");
    expect(versionNoticeStrings("ja").refresh).toBe(VERSION_NOTICE_STRINGS.ja.refresh);
  });

  it("falls back to English for an unknown or missing lang", () => {
    expect(versionNoticeStrings("tr").refresh).toBe("New version · Refresh");
    expect(versionNoticeStrings(undefined).refresh).toBe("New version · Refresh");
  });

  it("has every locale, each with its own words", () => {
    expect(Object.keys(VERSION_NOTICE_STRINGS).sort()).toEqual([...VERSION_NOTICE_LOCALES].sort());
    for (const l of VERSION_NOTICE_LOCALES.filter((l) => l !== "en"))
      expect(VERSION_NOTICE_STRINGS[l].refresh).not.toBe(VERSION_NOTICE_STRINGS.en.refresh);
  });
});
