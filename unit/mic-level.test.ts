import { describe, expect, it } from "bun:test";
import {
  METER_KEY,
  MIN_DB,
  PEAK_FALL_DB_S,
  bandOf,
  dbFrac,
  meterOn,
  meterStep,
} from "@lianki/debug-chat/mic-level";

describe("the mic meter", () => {
  it("dbFrac maps -70..0 dBFS onto the bar, clamped", () => {
    expect(dbFrac(MIN_DB)).toBe(0);
    expect(dbFrac(-35)).toBeCloseTo(0.5);
    expect(dbFrac(6)).toBe(1);
    expect(dbFrac(-200)).toBe(0);
  });

  it("rises fast, falls slowly; the peak holds and falls back", () => {
    let m = { level: -70, peak: -70 };
    m = meterStep(m, -20, 50);
    expect(m.level).toBeCloseTo(-40);
    expect(m.peak).toBeCloseTo(-40);
    const quiet = meterStep(m, -70, 1000);
    expect(quiet.level).toBeCloseTo(-44.5);
    expect(quiet.peak).toBeCloseTo(Math.max(quiet.level, -40 - PEAK_FALL_DB_S));
    expect(meterStep(m, -30, 50, false)).toEqual({ level: -30, peak: -30 });
  });

  it("the band, and the setting (on unless '0')", () => {
    expect(bandOf({ whisper: true, floorDb: -60 })).toBe("whisper");
    expect(bandOf({ whisper: false, floorDb: -40 })).toBe("noisy");
    expect(bandOf({ whisper: false, floorDb: -60 })).toBe("normal");
    const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: { getItem: (k: string) => store.get(k) ?? null },
    });
    try {
      expect(meterOn()).toBe(true);
      store.set(METER_KEY, "0");
      expect(meterOn()).toBe(false);
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new Error("blocked");
        },
      });
      expect(meterOn()).toBe(true);
    } finally {
      if (had) Object.defineProperty(globalThis, "localStorage", had);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
});
