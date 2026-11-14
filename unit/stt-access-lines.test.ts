import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { accountLabel, fill, shortId, txt, workerMeta } from "@/app/(app)/dev/stt-access/lines";

/**
 * A `useIntlayer` leaf as react-intlayer builds it (renderIntlayerNode): a
 * React element proxied so `.value` is the text. `String(leaf)` of it is
 * "[object Object]", which is what /dev/stt-access showed.
 */
const leaf = (value: string) =>
  new Proxy(createElement(Fragment, null, value), {
    get: (el, k, r) => (k === "value" ? value : Reflect.get(el, k, r)),
  });

const c = {
  capacity: leaf("Sessions at once: {n}"),
  capacityDefault: leaf("the default"),
  personal: leaf("Personal server of one account"),
};

describe("/dev/stt-access row text", () => {
  test("a leaf is a React element, not a string", () => {
    expect(String(c.personal)).toBe("[object Object]");
    expect(txt(c.personal)).toBe("Personal server of one account");
    expect(txt("plain")).toBe("plain");
    expect(txt(null)).toBe("");
    expect(txt({})).toBe("");
  });

  test("a personal server's line names it in words and by account id", () => {
    const line = workerMeta({ capacity: 2, ownerUserId: "u1" }, c, "11 Nov 2026 JST");
    expect(line).toBe(
      "Sessions at once: 2 · Personal server of one account (u1) · 11 Nov 2026 JST",
    );
    expect(line).not.toContain("[object Object]");
  });

  test("a shared server with no capacity says the default", () => {
    expect(workerMeta({ capacity: null, ownerUserId: null }, c, "then")).toBe(
      "Sessions at once: the default · then",
    );
  });

  test("an account is its name, else its id; never an email", () => {
    expect(accountLabel({ userId: "u1", name: " Ann " })).toBe("Ann");
    expect(accountLabel({ userId: "u2", name: null })).toBe("u2");
    expect(accountLabel({ userId: "u3", name: "  " })).toBe("u3");
    expect(accountLabel({ userId: "u4", name: { first: "x" } })).toBe("u4");
    const row = { userId: "u5", name: null, email: "bob@x.com" } as never;
    expect(accountLabel(row)).not.toContain("@");
  });

  test("fill leaves unknown placeholders alone", () => {
    expect(fill("{n} of {m}", { n: 1 })).toBe("1 of {m}");
  });
});

describe("shortId", () => {
  test("keeps the first six characters of a long id, short ids as they are", () => {
    expect(shortId("abcdefghijklmnop")).toBe("abcdef…");
    expect(shortId("abc")).toBe("abc");
  });
});
