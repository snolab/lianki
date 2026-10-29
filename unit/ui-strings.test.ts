import { describe, expect, it } from "bun:test";
import {
  TREE_ZH,
  UI_EN,
  UI_ZH,
  isZh,
  treeDefaults,
  uiStrings,
} from "@lianki/debug-chat/ui-strings";
import { TREE_STRINGS_EN } from "@lianki/debug-chat/StateTree";

describe("ui strings", () => {
  it("picks Chinese for zh pages, English otherwise", () => {
    expect(isZh("zh")).toBe(true);
    expect(isZh("zh-CN")).toBe(true);
    expect(isZh("zh-Hant-TW")).toBe(true);
    expect(isZh("en")).toBe(false);
    expect(isZh("")).toBe(false);
    expect(isZh(null)).toBe(false);
    expect(isZh(undefined)).toBe(false); // no document in tests
    expect(uiStrings("zh-CN")).toBe(UI_ZH);
    expect(uiStrings("ja")).toBe(UI_EN);
    expect(treeDefaults("zh")).toBe(TREE_ZH);
    expect(treeDefaults("en")).toEqual({});
  });

  it("covers every string of the English tables", () => {
    expect(Object.keys(TREE_ZH).sort()).toEqual(Object.keys(TREE_STRINGS_EN).sort());
    expect(Object.keys(UI_ZH).sort()).toEqual(Object.keys(UI_EN).sort());
    expect(TREE_ZH.openCount).toContain("{n}");
  });
});
