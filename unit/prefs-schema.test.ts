import { describe, expect, it } from "bun:test";
import {
  CATALOG_URLS,
  checkPref,
  comparePrefHlc,
  PREF_KEYS,
  PREF_SCHEMAS,
} from "@/lib/prefs/schema";
import { prefBindings } from "@/lib/prefs/bindings";

/**
 * docs/prefs-sync.md, "Privacy": no device URL or tailnet host can reach the
 * server. Every key's schema is probed with the shapes such a value could
 * take, alone, in an array and in an object.
 */
const DEVICE = [
  "https://taku.onca-tint.ts.net/lianki-stt",
  "http://localhost:3000/debug-chat.js",
  "http://127.0.0.1:8787",
  "http://192.168.31.96:3100/",
  "wss://mac.tail1234.ts.net:8443/stt",
  "taku.onca-tint.ts.net",
  "/lianki-debug.ts.net",
  "//evil.example/x",
  "file:///Users/taku/clip",
];

describe("prefs schema: nothing device-specific is accepted", () => {
  for (const key of PREF_KEYS) {
    it(key, () => {
      for (const u of DEVICE) {
        for (const v of [u, [u], { u }, { url: u }, [{ url: u }]])
          expect(checkPref(key, v)).toBeUndefined();
      }
    });
  }

  it("the device-local settings have no key at all", () => {
    for (const k of [
      "chat-voice.aec",
      "chat.mic",
      "words.fullscreen",
      "debug.localStt",
      "debug.widgetSrc",
      "debug.slotsSrc",
      "debug.clipSink",
      "chat.pos",
      "debug.on",
    ])
      expect(checkPref(k, true)).toBeUndefined();
    const local = /aec|\bmic|fullscreen|stt|widget|slots|tree|clip|\.pos\b|debug/i;
    for (const k of PREF_KEYS) expect(local.test(k)).toBe(false);
  });

  it("every binding has a schema, and every schema a binding", () => {
    const bound = prefBindings().map((b) => b.key);
    expect([...bound].sort()).toEqual([...PREF_KEYS].sort());
  });

  it("only the home matrix's public sites pass as a URL", () => {
    const site = [...CATALOG_URLS][0];
    expect(checkPref("home.pins", [site])).toEqual([site]);
    expect(checkPref("home.pins", ["https://example.com/"])).toBeUndefined();
  });
});

describe("prefs schema: values", () => {
  it("accepts the settings as the app writes them", () => {
    const ok: Record<string, unknown> = {
      "words.showAll": true,
      "swipe.variant": "native",
      "swipe-feel.preset": "heavy",
      "swipe-feel.tweaks": { friction: 12, lift: 0.5 },
      "motion.animations": "off",
      "ui.paper": "c",
      "ui.locale": "ja",
      "nav-pins.pinned": ["/words?list=n5", "/sites"],
      "home.lang": "ja",
      "lab.immersionLangs": ["ja", "zh"],
      "chat-voice.rate": 1.25,
      "chat-voice.out": "cloud",
      "chat-voice.speak": false,
    };
    for (const [k, v] of Object.entries(ok)) expect(checkPref(k, v)).toEqual(v);
  });

  it("refuses junk: wrong types, out of range, unknown tokens, unknown keys", () => {
    expect(checkPref("words.showAll", "yes")).toBeUndefined();
    expect(checkPref("chat-voice.rate", 3)).toBeUndefined();
    expect(checkPref("swipe-feel.tweaks", { friction: 1e9 })).toBeUndefined();
    expect(checkPref("swipe-feel.tweaks", { note: "hi" })).toBeUndefined();
    expect(checkPref("motion.animations", "system")).toBeUndefined();
    expect(checkPref("nope", true)).toBeUndefined();
    expect(checkPref("__proto__", {})).toBeUndefined();
    expect(checkPref("nav-pins.pinned", Array(13).fill("/words"))).toBeUndefined();
  });

  it("every schema is a zod schema", () => {
    for (const k of PREF_KEYS) expect(typeof PREF_SCHEMAS[k].safeParse).toBe("function");
  });
});

describe("comparePrefHlc", () => {
  it("timestamp, then counter, then device id in byte order", () => {
    const h = (timestamp: number, counter: number, deviceId: string) => ({
      timestamp,
      counter,
      deviceId,
    });
    expect(comparePrefHlc(h(2, 0, "a0000000"), h(1, 9, "z0000000"))).toBeGreaterThan(0);
    expect(comparePrefHlc(h(1, 2, "a0000000"), h(1, 1, "z0000000"))).toBeGreaterThan(0);
    expect(comparePrefHlc(h(1, 1, "b0000000"), h(1, 1, "a0000000"))).toBeGreaterThan(0);
    expect(comparePrefHlc(undefined, h(1, 1, "a0000000"))).toBeLessThan(0);
    expect(comparePrefHlc(undefined, undefined)).toBe(0);
  });
});
