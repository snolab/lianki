import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  USERSCRIPT_CONTEXT,
  USERSCRIPT_LOCALES,
  USERSCRIPT_STRINGS,
  fillUs,
  friendlyError,
  userscriptStrings,
} from "@/src/userscript-strings";

const placeholders = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();

// The userscript's panel in the app's 16 locales; errors in plain words.
describe("userscript strings", () => {
  it("every locale has every string, with the English placeholders", () => {
    expect(USERSCRIPT_LOCALES.length).toBe(16);
    const keys = Object.keys(USERSCRIPT_STRINGS.en) as (keyof typeof USERSCRIPT_STRINGS.en)[];
    for (const l of USERSCRIPT_LOCALES)
      for (const k of keys) {
        expect(USERSCRIPT_STRINGS[l][k], `${l}.${k}`).toBeTruthy();
        expect(placeholders(USERSCRIPT_STRINGS[l][k]), `${l}.${k}`).toEqual(
          placeholders(USERSCRIPT_STRINGS.en[k]),
        );
      }
    for (const k of keys) expect(USERSCRIPT_CONTEXT[k].split(" ").length).toBeGreaterThan(5);
  });

  it("picks by the browser's language", () => {
    expect(userscriptStrings("ja-JP").delete).toBe("削除");
    expect(userscriptStrings("tr").delete).toBe("Delete");
    expect(fillUs(USERSCRIPT_STRINGS.en.due, { n: 3 })).toBe("due: 3");
  });

  it("an error reads as offline / sign in / server busy / other, never raw", () => {
    const t = USERSCRIPT_STRINGS.en;
    expect(friendlyError("Network error", t)).toBe(t.errOffline);
    expect(friendlyError("Request timed out", t)).toBe(t.errOffline);
    expect(friendlyError("Login required (POST https://lianki.com/api/fsrs/add)", t)).toBe(
      t.errSignIn,
    );
    expect(friendlyError("HTTP 500 — GET https://lianki.com/x — Error ID: abc", t)).toBe(
      t.errServer,
    );
    expect(friendlyError("HTTP 400 — bad", t)).toBe(t.errOther);
    expect(friendlyError(null, t)).toBe(t.errOther);
  });

  it("the panel shows the friendly line, not `Error: <raw>`", () => {
    const src = readFileSync("src/lianki.user.ts", "utf8");
    expect(src).toContain("errDiv.textContent = friendlyError(error, US);");
    expect(src).not.toContain("errDiv.textContent = `Error: ${error}`");
  });
});
