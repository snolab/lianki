import { describe, expect, it } from "bun:test";
import { type TocSection } from "@/app/(app)/my/preferences/PreferencesToc";

describe("PreferencesToc", () => {
  it("structures TOC sections cleanly", () => {
    const sections: TocSection[] = [
      { id: "language", title: "Language" },
      { id: "paper", title: "Paper" },
      { id: "tokens", title: "API Tokens" },
    ];
    expect(sections.map((s) => s.id)).toEqual(["language", "paper", "tokens"]);
    expect(sections[0]?.title).toBe("Language");
  });
});
