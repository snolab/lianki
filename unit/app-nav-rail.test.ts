import { describe, expect, it } from "bun:test";
import { APP_NAV, DEV_NAV_KEYS, MENU_NAV, railNav } from "@/lib/app-nav";

// Owner, 2026-11-09: import, data and settings move from the rail into the
// account menu; their URLs stay.
describe("rail and account menu", () => {
  it("my data, import, data and settings are in the account menu, in that order, not the rail", () => {
    expect(MENU_NAV.map((i) => i.href)).toEqual(["/my", "/import", "/data", "/my/preferences"]);
    const rail = railNav(["books"]).map((i) => i.href);
    for (const href of ["/my", "/import", "/data", "/my/preferences"])
      expect(rail).not.toContain(href);
  });

  it("the rail keeps every other visible item, flags still apply", () => {
    expect(railNav(["books", "library", "today", ...DEV_NAV_KEYS]).length + MENU_NAV.length).toBe(
      APP_NAV.length,
    );
    expect(railNav([]).some((i) => i.key === "today")).toBe(false);
    // The Lab group is for developers only (owner, 2026-11-10).
    expect(DEV_NAV_KEYS).toEqual(["lab", "aiVocab", "polyglot"]);
    expect(railNav([]).some((i) => i.group === "lab")).toBe(false);
    expect(railNav([]).some((i) => i.key === "books")).toBe(false);
    expect(railNav([])[0].key).toBe("home");
  });
});
