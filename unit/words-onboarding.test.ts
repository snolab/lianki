import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  autoShow,
  deviceSynced,
  hasSynced,
  markSeen,
  nextScene,
  ONBOARDED_KEY,
  parseSeen,
  prevScene,
  readSeen,
  SCENES,
} from "@/lib/words/onboarding";
import { prefBindings } from "@/lib/prefs/bindings";
import { FLAGS } from "@/lib/flags";

/** The /words first-visit walkthrough: shown once, then only from the "?". */
const g = globalThis as unknown as Record<string, unknown>;
let m: Map<string, string>;
beforeEach(() => {
  m = new Map();
  g.localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
});
afterEach(() => {
  delete g.localStorage;
});

describe("autoShow", () => {
  it("opens on a first visit with the flag on", () => {
    expect(autoShow({ flagOn: true, seen: undefined })).toBe(true);
    expect(autoShow({ flagOn: true, seen: false })).toBe(true);
  });
  it("never opens again once seen, nor with the flag off", () => {
    expect(autoShow({ flagOn: true, seen: true })).toBe(false);
    expect(autoShow({ flagOn: false, seen: undefined })).toBe(false);
  });
});

describe("seen state", () => {
  it("first visit reads as never written; finishing or skipping marks it seen", () => {
    expect(readSeen()).toBeUndefined();
    markSeen();
    expect(m.get(ONBOARDED_KEY)).toBe("1");
    expect(readSeen()).toBe(true);
    expect(autoShow({ flagOn: true, seen: readSeen() })).toBe(false);
  });
  it("parses only 1 and 0", () => {
    expect(parseSeen("1")).toBe(true);
    expect(parseSeen("0")).toBe(false);
    expect(parseSeen("yes")).toBeUndefined();
    expect(parseSeen(null)).toBeUndefined();
  });
  it("follows the account: the key is a synced preference", () => {
    const b = prefBindings().find((x) => x.key === "words.onboarded");
    expect(b).toBeDefined();
    expect(b!.fallback).toBe(false);
    b!.set(true); // seen on another device, applied here
    expect(readSeen()).toBe(true);
  });
  it("a device that never synced waits for the account; one that did trusts itself", () => {
    expect(hasSynced(null)).toBe(false);
    expect(hasSynced("{bad")).toBe(false);
    expect(hasSynced(JSON.stringify({ cursor: 0 }))).toBe(false);
    expect(hasSynced(JSON.stringify({ cursor: 1731200000000 }))).toBe(true);
    expect(deviceSynced()).toBe(false);
    m.set("lk:pref-sync", JSON.stringify({ cursor: 5 }));
    expect(deviceSynced()).toBe(true);
  });
  it("storage that throws reads as first visit and never crashes", () => {
    g.localStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(readSeen()).toBeUndefined();
    expect(() => markSeen()).not.toThrow();
  });
});

describe("scenes", () => {
  it("five scenes in the approved order, stepped and clamped", () => {
    expect([...SCENES]).toEqual(["tap", "rate", "handled", "returns", "pinch"]);
    expect(nextScene(0)).toBe(1);
    expect(nextScene(SCENES.length - 1)).toBeNull();
    expect(prevScene(0)).toBe(0);
    expect(prevScene(3)).toBe(2);
  });
  it("the flag is positive, on by default, for everyone", () => {
    const f = FLAGS["words.onboarding"] as { default: boolean; audience?: string };
    expect(f.default).toBe(true);
    expect(f.audience).toBeUndefined();
  });
});
