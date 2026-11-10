import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  askNowIn,
  checkDontAsk,
  chooseIn,
  DONT_ASK_CONFIG,
  DONT_ASK_KEY,
  dontAskId,
  dontAskRows,
  forgetIn,
  isQuiet,
  parseDontAskId,
  reaskAfter,
} from "@/lib/dont-ask";
import { checkPref } from "@/lib/prefs/schema";

const D = 20_400; // a day number

describe("spacing", () => {
  it("waits longer each time it is chosen again, then repeats the last", () => {
    const [a, b, c, d] = DONT_ASK_CONFIG.reaskDays;
    expect([1, 2, 3, 4, 5, 9].map((n) => reaskAfter(n))).toEqual([a, b, c, d, d, d]);
    expect(a).toBeLessThan(b!);
    expect(reaskAfter(0)).toBe(a);
  });

  it("first choice: quiet until the first interval is over, then asks", () => {
    const m = chooseIn({}, "read-polish", D);
    expect(m["read-polish"]).toEqual([1, D, D + reaskAfter(1)]);
    expect(isQuiet(m, "read-polish", D)).toBe(true);
    expect(isQuiet(m, "read-polish", D + reaskAfter(1) - 1)).toBe(true);
    expect(isQuiet(m, "read-polish", D + reaskAfter(1))).toBe(false);
  });

  it("chosen again when it comes back: the next, longer interval", () => {
    let m = chooseIn({}, "link-any", D);
    const back = D + reaskAfter(1);
    m = chooseIn(m, "link-any", back);
    expect(m["link-any"]).toEqual([2, back, back + reaskAfter(2)]);
  });

  it("no entry asks (a choice made before the map, or dropped)", () => {
    expect(isQuiet({}, "link-any", D)).toBe(false);
  });

  it("ask again now keeps the count; forget drops it", () => {
    const m = chooseIn(chooseIn({}, "link-any", D), "link-any", D + 1);
    const now = askNowIn(m, "link-any", D + 3);
    expect(now["link-any"]).toEqual([2, D + 1, D + 3]);
    expect(isQuiet(now, "link-any", D + 3)).toBe(false);
    expect(chooseIn(now, "link-any", D + 3)["link-any"]![0]).toBe(3);
    expect(forgetIn(now, "link-any")).toEqual({});
    expect(askNowIn({}, "link-any", D)).toEqual({});
  });
});

describe("ids and the stored map", () => {
  it("knows its kinds; a site id carries a public host", () => {
    expect(dontAskId("link-site", "wikipedia.org")).toBe("link-site:wikipedia.org");
    expect(parseDontAskId("link-site:wikipedia.org")).toEqual({
      kind: "link-site",
      subject: "wikipedia.org",
    });
    expect(parseDontAskId("link-any")).toEqual({ kind: "link-any" });
    for (const bad of [
      "nope",
      "link-any:x",
      "link-site:",
      "link-site:localhost",
      "link-site:taku.onca-tint.ts.net",
      "link-site:192.168.1.2",
    ])
      expect(parseDontAskId(bad)).toBeNull();
  });

  it("drops junk entries", () => {
    expect(
      checkDontAsk({
        "link-any": [1, D, D + 7],
        "read-polish": [1, D, "x"],
        "link-site:localhost": [1, D, D + 7],
        other: [1, D, D + 7],
      }),
    ).toEqual({ "link-any": [1, D, D + 7] });
    expect(checkDontAsk(null)).toEqual({});
    expect(checkDontAsk([1])).toEqual({});
  });

  it("keeps the newest chosen under the count and byte caps", () => {
    let m = {};
    for (let i = 0; i < 70; i++) m = chooseIn(m, `link-site:site${i}.example.org`, D + i);
    const ids = Object.keys(m);
    expect(ids.length).toBeLessThanOrEqual(DONT_ASK_CONFIG.max);
    expect(JSON.stringify(m).length).toBeLessThanOrEqual(DONT_ASK_CONFIG.maxBytes);
    expect(ids).toContain("link-site:site69.example.org");
    expect(ids).not.toContain("link-site:site0.example.org");
    expect(checkPref("asks.dontAsk", m)).toEqual(m);
  });

  it("the account pref takes only a clean map", () => {
    expect(checkPref("asks.dontAsk", { "link-any": [1, D, D + 7] })).toEqual({
      "link-any": [1, D, D + 7],
    });
    expect(checkPref("asks.dontAsk", { "link-site:localhost": [1, D, D + 7] })).toBeUndefined();
    expect(checkPref("asks.dontAsk", { "link-any": [1, D] })).toBeUndefined();
  });

  it("the review list: due first, with kind and subject", () => {
    const m = {
      "link-site:a.org": [1, D, D + 30] as const,
      "read-polish": [2, D - 40, D - 1] as const,
    };
    const rows = dontAskRows(m, D);
    expect(rows.map((r) => [r.id, r.isDue])).toEqual([
      ["read-polish", true],
      ["link-site:a.org", false],
    ]);
    expect(rows[1]).toMatchObject({ kind: "link-site", subject: "a.org", n: 1 });
  });
});

describe("the dialogs through the helper (localStorage)", () => {
  let store: Map<string, string>;
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  beforeEach(() => {
    store = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });
  afterEach(() => {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const today = () => Math.floor(Date.now() / 86_400_000);
  const map = () => JSON.parse(store.get(DONT_ASK_KEY) ?? "{}");

  it("links: a site's no asks again once due, and an unticked answer drops it", async () => {
    const { allowHost, answerLeave, readLinkPolicy } = await import("@/lib/external-link");
    allowHost("wikipedia.org");
    expect(readLinkPolicy().hosts).toEqual(["wikipedia.org"]);
    expect(map()["link-site:wikipedia.org"][0]).toBe(1);
    // the day comes
    store.set(DONT_ASK_KEY, JSON.stringify({ "link-site:wikipedia.org": [1, 1, today()] }));
    expect(readLinkPolicy().hosts).toEqual([]);
    // ticked again: the second interval
    answerLeave("wikipedia.org", { skipSite: true, skipAll: false });
    expect(map()["link-site:wikipedia.org"]).toEqual([2, today(), today() + reaskAfter(2)]);
    // due again, and opened without the box: gone
    store.set(DONT_ASK_KEY, JSON.stringify({ "link-site:wikipedia.org": [2, 1, today()] }));
    answerLeave("wikipedia.org", { skipSite: false, skipAll: false });
    expect(map()).toEqual({});
    expect(JSON.parse(store.get("lk:link-allowed")!)).toEqual([]);
  });

  it("links: 'any site' expires like the rest", async () => {
    const { answerLeave, readLinkPolicy } = await import("@/lib/external-link");
    answerLeave("example.org", { skipSite: false, skipAll: true });
    expect(readLinkPolicy().confirm).toBe(false);
    store.set(DONT_ASK_KEY, JSON.stringify({ "link-any": [1, 1, today()] }));
    expect(readLinkPolicy().confirm).toBe(true);
    answerLeave("example.org", { skipSite: false, skipAll: false });
    expect(store.get("lk:link-confirm")).toBe("1");
    expect(map()).toEqual({});
  });

  it("reader: 'Don't ask again' comes back, and another answer drops it", async () => {
    const { answerOffer, readOfferOn, writeOfferOn } = await import("@/lib/read/polish-offer");
    writeOfferOn(false);
    expect(readOfferOn()).toBe(false);
    store.set(DONT_ASK_KEY, JSON.stringify({ "read-polish": [1, 1, today()] }));
    expect(readOfferOn()).toBe(true);
    answerOffer();
    expect(store.get("lk:read-polish-offer")).toBe("1");
    expect(map()).toEqual({});
  });
});
