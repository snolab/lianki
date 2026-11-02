import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createUiStore, resetUiStores } from "@lianki/ui-state";
import { bool10, prefBindings } from "@/lib/prefs/bindings";
import { CATALOG_URLS, checkPref } from "@/lib/prefs/schema";

/** Where each account preference lives on the device (lib/prefs/bindings.ts). */
const g = globalThis as unknown as Record<string, unknown>;
let m: Map<string, string>;
let cookies: string[];
let dataset: Record<string, string>;

beforeEach(() => {
  resetUiStores();
  m = new Map();
  cookies = [];
  dataset = {};
  g.localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  g.document = {
    documentElement: { dataset },
    set cookie(c: string) {
      cookies.push(c);
    },
  };
});
afterEach(() => {
  delete g.localStorage;
  delete g.document;
  delete g.window;
  resetUiStores();
});

const b = (key: string) => prefBindings().find((x) => x.key === key)!;

const SAMPLE: Record<string, unknown> = {
  "words.showAll": true,
  "words.readAloud": false,
  "words.serverVoice": false,
  "words.speakOnSwipe": false,
  "words.gradeTones": false,
  "words.paperScrolls": true,
  "swipe.variant": "native",
  "swipe-feel.preset": "heavy",
  "swipe-feel.tweaks": { friction: 10 },
  "motion.animations": "off",
  "ui.paper": "c",
  "ui.locale": "ja",
  "nav-pins.pinned": ["/words"],
  "home.lang": "ja",
  "home.pins": [[...CATALOG_URLS][0]],
  "lab.immersionLangs": ["ja"],
  "lab.immersionTranspose": true,
  "chat-voice.rate": 2,
  "chat-voice.out": "cloud",
  "chat-voice.speak": false,
};

describe("prefBindings", () => {
  it("nothing set: every binding reads undefined, and its default passes its schema", () => {
    for (const x of prefBindings()) {
      expect(x.get()).toBeUndefined();
      expect(checkPref(x.key, x.fallback)).toEqual(x.fallback);
    }
  });

  it("every binding round-trips a value through the device's storage", () => {
    for (const x of prefBindings()) {
      x.set(SAMPLE[x.key]);
      expect(x.get()).toEqual(SAMPLE[x.key]);
    }
    // the keys the features already read
    expect(m.get("lk:words-show-all")).toBe("1");
    expect(m.get("lk:words-sound")).toBe("off");
    expect(m.get("lk:swipe-ab")).toBe("native");
    expect(m.get("lk:agent-speech-rate")).toBe("2");
    expect(m.get("lk:debug-chat-speak")).toBe("0");
    expect(JSON.parse(m.get("lk:pref:motion")!)).toEqual({
      state: { animations: "off" },
      version: 1,
    });
    expect(dataset.paper).toBe("c");
    expect(cookies.some((c) => c.startsWith("lang=ja;"))).toBe(true);
  });

  it("a store field goes through the page's store when it has one", () => {
    g.window = { localStorage: g.localStorage, addEventListener: () => {} };
    const store = createUiStore(
      "motion",
      1,
      { animations: "system" as string },
      { storage: "account" },
    );
    const x = b("motion.animations");
    expect(x.get()).toBeUndefined(); // "system" is not a choice
    x.set("off");
    expect(store.getState().animations).toBe("off");
    expect(x.get()).toBe("off");
  });

  it("a stored copy of another version is left alone", () => {
    m.set("lk:pref:motion", JSON.stringify({ state: { animations: "off" }, version: 9 }));
    const x = b("motion.animations");
    expect(x.get()).toBeUndefined();
    x.set("on");
    expect(JSON.parse(m.get("lk:pref:motion")!).version).toBe(9);
    m.set("lk:pref:motion", "{bad");
    expect(x.get()).toBeUndefined();
  });

  it("home pins: only the matrix's sites are synced; your own stay on the device", () => {
    const site = [...CATALOG_URLS][0];
    m.set("lk:home:pins", JSON.stringify(["https://my.example/", site]));
    const x = b("home.pins");
    expect(x.get()).toEqual([site]);
    x.set([]);
    expect(JSON.parse(m.get("lk:home:pins")!)).toEqual(["https://my.example/"]);
    m.set("lk:home:pins", "nope");
    expect(x.get()).toEqual([]);
  });

  it("the chat's speak switch reads its old name too", () => {
    m.set("lk:debug-chat-speak", "0");
    expect(b("chat-voice.speak").get()).toBe(false);
  });

  it("junk on the device reads as unset", () => {
    m.set("lk:words-show-all", "maybe");
    m.set("lk:agent-speech-rate", "");
    m.set("lk:lab:immersion:langs", "{");
    expect(b("words.showAll").get()).toBeUndefined();
    expect(b("chat-voice.rate").get()).toBeUndefined();
    expect(b("lab.immersionLangs").get()).toBeUndefined();
    expect(bool10.encode(false)).toBe("0");
  });

  it("no storage at all (private mode): nothing throws", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    delete g.document;
    for (const x of prefBindings()) {
      expect(x.get()).toBeUndefined();
      expect(() => x.set(SAMPLE[x.key])).not.toThrow();
    }
  });
});
