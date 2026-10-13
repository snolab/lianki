import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { asWatchTracking, DEFAULT_WATCH_TRACKING } from "@lianki/core";

describe("asWatchTracking", () => {
  it("is on unless explicitly switched off", () => {
    // The preference reaches the userscript through a cache that may predate
    // the setting. Treating "not yet known" as off would silently stop
    // recording for everyone until the first fetch landed.
    expect(asWatchTracking(undefined)).toBe(true);
    expect(asWatchTracking(null)).toBe(true);
    expect(asWatchTracking(true)).toBe(true);
    expect(DEFAULT_WATCH_TRACKING).toBe(true);
  });

  it("is off only for a real false", () => {
    expect(asWatchTracking(false)).toBe(false);
    // Anything else is a malformed value, not a decision to stop recording.
    expect(asWatchTracking("false")).toBe(true);
    expect(asWatchTracking(0)).toBe(true);
  });
});

describe("the userscript honours it", () => {
  const BUILT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

  it("gates recording itself, not merely what counts", () => {
    // WATCH_REQUIRE_VISIBLE / WATCH_REQUIRE_AUDIBLE decide what counts once
    // recording is on; before this they were the only controls, so there was
    // no way for a user — or a store reviewer — to decline it at all.
    const start = BUILT.indexOf("isWatchActive = (v) =>");
    expect(start).toBeGreaterThan(-1);
    expect(BUILT.slice(start, start + 200)).toContain("watchTrackingOn()");
  });

  it("reads it from preferences, defaulting to on", () => {
    expect(BUILT).toMatch(/watchTrackingOn = \(\) => .*watchTracking !== false/);
  });
});
