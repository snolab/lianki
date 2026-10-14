import { describe, expect, test } from "bun:test";
import { isSuppressedPath, parseChoice, shouldAsk, type FirstRunChoice } from "@/lib/first-run";

/**
 * When to ask a first-time visitor whether they want Lianki locally or with an
 * account. The interruption rules are the whole point: ask once, never on the
 * sign-in page, and never before we can read what they already answered.
 */
const base = {
  signedIn: false,
  pathname: "/list",
  stored: null as FirstRunChoice | null,
  mounted: true,
};

describe("asking once", () => {
  test("asks a brand-new signed-out visitor", () => {
    expect(shouldAsk(base)).toBe(true);
  });

  test("never asks again once they have answered, either way", () => {
    expect(shouldAsk({ ...base, stored: "local" })).toBe(false);
    expect(shouldAsk({ ...base, stored: "account" })).toBe(false);
  });

  test("does not ask someone who is signed in — they answered by signing in", () => {
    expect(shouldAsk({ ...base, signedIn: true })).toBe(false);
  });

  test("stays silent until mounted, so it cannot flash or mismatch hydration", () => {
    // localStorage is unreadable on the server, so an unmounted render would
    // show the prompt to people who already chose.
    expect(shouldAsk({ ...base, mounted: false })).toBe(false);
  });
});

describe("where it must not appear", () => {
  test("not on the sign-in page, which lives inside the app group", () => {
    expect(shouldAsk({ ...base, pathname: "/sign-in" })).toBe(false);
  });

  test("not on a locale-prefixed sign-in page", () => {
    // The reported failure was /sign-in?lang=fr; routes also come as /fr/sign-in.
    expect(isSuppressedPath("/fr/sign-in")).toBe(true);
    expect(isSuppressedPath("/zh/sign-up")).toBe(true);
    expect(shouldAsk({ ...base, pathname: "/fr/sign-in" })).toBe(false);
  });

  test("still asks on ordinary app pages", () => {
    for (const p of ["/list", "/fr/list", "/read", "/data", "/learn"]) {
      expect(shouldAsk({ ...base, pathname: p })).toBe(true);
    }
  });

  test("a page merely containing the word does not count as sign-in", () => {
    expect(isSuppressedPath("/blog/why-sign-in-is-optional")).toBe(false);
  });
});

describe("reading the stored answer", () => {
  test("accepts only values we wrote", () => {
    expect(parseChoice("local")).toBe("local");
    expect(parseChoice("account")).toBe("account");
  });

  test("treats absent, empty or foreign values as unanswered", () => {
    // A cleared or blocked localStorage returns null, and a private window can
    // hand back something else entirely; both mean "ask".
    for (const v of [null, undefined, "", "true", "1", "LOCAL", "{}"]) {
      expect(parseChoice(v)).toBeNull();
    }
  });
});
