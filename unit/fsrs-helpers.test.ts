import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  compareHLC,
  newServerHLC,
  RATING_MAP,
  buildNextDueQuery,
  type HLC,
} from "../app/fsrs-helpers";
import { Rating } from "ts-fsrs";

// ── compareHLC ───────────────────────────────────────────────────────────────

describe("compareHLC", () => {
  it("returns -1 when a is undefined", () => {
    const b: HLC = { timestamp: 1000, counter: 0, deviceId: "server" };
    expect(compareHLC(undefined, b)).toBe(-1);
  });

  it("returns 1 when b is undefined", () => {
    const a: HLC = { timestamp: 1000, counter: 0, deviceId: "server" };
    expect(compareHLC(a, undefined)).toBe(1);
  });

  it("returns -1 when both are undefined (a checked first)", () => {
    expect(compareHLC(undefined, undefined)).toBe(-1);
  });

  it("compares by timestamp first", () => {
    const a: HLC = { timestamp: 1000, counter: 5, deviceId: "a" };
    const b: HLC = { timestamp: 2000, counter: 0, deviceId: "b" };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
  });

  it("compares by counter when timestamps are equal", () => {
    const a: HLC = { timestamp: 1000, counter: 1, deviceId: "a" };
    const b: HLC = { timestamp: 1000, counter: 3, deviceId: "b" };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
  });

  it("compares by deviceId when timestamp and counter are equal", () => {
    const a: HLC = { timestamp: 1000, counter: 0, deviceId: "alpha" };
    const b: HLC = { timestamp: 1000, counter: 0, deviceId: "beta" };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 for identical HLCs", () => {
    const a: HLC = { timestamp: 1000, counter: 0, deviceId: "server" };
    const b: HLC = { timestamp: 1000, counter: 0, deviceId: "server" };
    expect(compareHLC(a, b)).toBe(0);
  });
});

// ── newServerHLC ─────────────────────────────────────────────────────────────

describe("newServerHLC", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a fresh HLC when no lastHLC is provided", () => {
    vi.setSystemTime(5000);
    const hlc = newServerHLC();
    expect(hlc).toEqual({ timestamp: 5000, counter: 0, deviceId: "server" });
  });

  it("returns a fresh HLC when lastHLC is null", () => {
    vi.setSystemTime(5000);
    const hlc = newServerHLC(null);
    expect(hlc).toEqual({ timestamp: 5000, counter: 0, deviceId: "server" });
  });

  it("returns a fresh HLC when now > lastHLC.timestamp", () => {
    vi.setSystemTime(6000);
    const last: HLC = { timestamp: 5000, counter: 3, deviceId: "client" };
    const hlc = newServerHLC(last);
    expect(hlc).toEqual({ timestamp: 6000, counter: 0, deviceId: "server" });
  });

  it("increments counter when now === lastHLC.timestamp", () => {
    vi.setSystemTime(5000);
    const last: HLC = { timestamp: 5000, counter: 2, deviceId: "client" };
    const hlc = newServerHLC(last);
    expect(hlc).toEqual({ timestamp: 5000, counter: 3, deviceId: "server" });
  });

  it("increments counter when now < lastHLC.timestamp (clock drift)", () => {
    vi.setSystemTime(4000);
    const last: HLC = { timestamp: 5000, counter: 0, deviceId: "client" };
    const hlc = newServerHLC(last);
    expect(hlc).toEqual({ timestamp: 5000, counter: 1, deviceId: "server" });
  });
});

// ── RATING_MAP ───────────────────────────────────────────────────────────────

describe("RATING_MAP", () => {
  it("maps numeric strings to ratings", () => {
    expect(RATING_MAP["1"]).toBe(Rating.Again);
    expect(RATING_MAP["2"]).toBe(Rating.Hard);
    expect(RATING_MAP["3"]).toBe(Rating.Good);
    expect(RATING_MAP["4"]).toBe(Rating.Easy);
  });

  it("maps word strings to ratings", () => {
    expect(RATING_MAP["again"]).toBe(Rating.Again);
    expect(RATING_MAP["hard"]).toBe(Rating.Hard);
    expect(RATING_MAP["good"]).toBe(Rating.Good);
    expect(RATING_MAP["easy"]).toBe(Rating.Easy);
  });

  it("returns undefined for unknown keys", () => {
    expect(RATING_MAP["5"]).toBeUndefined();
    expect(RATING_MAP["bad"]).toBeUndefined();
  });
});

// ── buildNextDueQuery ────────────────────────────────────────────────────────

describe("buildNextDueQuery", () => {
  it("returns base query with no exclusions", () => {
    const query = buildNextDueQuery([]);
    expect(query).toHaveProperty("card.due");
    expect(query["card.due"]).toHaveProperty("$lte");
    expect(query.url).toEqual({ $exists: true, $ne: null });
  });

  it("excludes a specific URL when excludeUrl is provided", () => {
    const query = buildNextDueQuery([], "https://example.com/card-a");
    expect(query.url.$nin).toEqual(["https://example.com/card-a"]);
    expect(query.url.$exists).toBe(true);
    expect(query.url.$ne).toBeNull();
  });

  it("excludes domains when excludeDomains is provided", () => {
    const query = buildNextDueQuery(["youtube.com", "twitter.com"]);
    expect(query.url.$not).toBeInstanceOf(RegExp);
    expect(query.url.$not.test("https://youtube.com/watch?v=123")).toBe(true);
    expect(query.url.$not.test("https://twitter.com/post")).toBe(true);
    expect(query.url.$not.test("https://wikipedia.org/wiki/Test")).toBe(false);
  });

  it("escapes dots in domain names for regex", () => {
    const query = buildNextDueQuery(["example.com"]);
    // Should NOT match "exampleXcom" (dot must be literal)
    expect(query.url.$not.test("https://exampleXcom/page")).toBe(false);
    expect(query.url.$not.test("https://example.com/page")).toBe(true);
  });

  it("combines excludeUrl and excludeDomains", () => {
    const query = buildNextDueQuery(
      ["youtube.com"],
      "https://en.wikipedia.org/wiki/Spaced_repetition",
    );
    expect(query.url.$nin).toEqual(["https://en.wikipedia.org/wiki/Spaced_repetition"]);
    expect(query.url.$not).toBeInstanceOf(RegExp);
    expect(query.url.$exists).toBe(true);
    expect(query.url.$ne).toBeNull();
  });

  it("card.due is always <= now", () => {
    const before = new Date();
    const query = buildNextDueQuery([]);
    const after = new Date();
    const dueFilter = query["card.due"].$lte as Date;
    expect(dueFilter.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(dueFilter.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ── FSRS Hard always produces future due date ────────────────────────────────

describe("FSRS Hard rating always produces future due date", () => {
  it("NEW card: Hard due > now", async () => {
    const { createEmptyCard, fsrs, generatorParameters, Rating } = await import("ts-fsrs");
    const config = fsrs(generatorParameters({ enable_fuzz: true }));
    const card = createEmptyCard();
    const now = new Date();
    const result = config.repeat(card, now)[Rating.Hard];
    expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
  });

  it("LEARNING card: Hard due > now", async () => {
    const { createEmptyCard, fsrs, generatorParameters, Rating } = await import("ts-fsrs");
    const config = fsrs(generatorParameters({ enable_fuzz: true }));
    const card = createEmptyCard();
    // Move to Learning by reviewing once
    const learning = config.repeat(card, new Date())[Rating.Good].card;
    const now = new Date();
    const result = config.repeat(learning, now)[Rating.Hard];
    expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
  });

  it("REVIEW card: Hard due > now", async () => {
    const { createEmptyCard, fsrs, generatorParameters, Rating } = await import("ts-fsrs");
    const config = fsrs(generatorParameters({ enable_fuzz: true }));
    let card = createEmptyCard();
    // Move through learning into review state
    for (let i = 0; i < 5; i++) {
      card = config.repeat(card, new Date(Date.now() + i * 86400000))[Rating.Good].card;
    }
    const now = new Date();
    const result = config.repeat(card, now)[Rating.Hard];
    expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
  });

  it("RELEARNING card: Hard due > now", async () => {
    const { createEmptyCard, fsrs, generatorParameters, Rating } = await import("ts-fsrs");
    const config = fsrs(generatorParameters({ enable_fuzz: true }));
    let card = createEmptyCard();
    for (let i = 0; i < 5; i++) {
      card = config.repeat(card, new Date(Date.now() + i * 86400000))[Rating.Good].card;
    }
    // Move to Relearning via Again
    card = config.repeat(card, new Date())[Rating.Again].card;
    const now = new Date();
    const result = config.repeat(card, now)[Rating.Hard];
    expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
  });

  it("Again rating also produces future due date", async () => {
    const { createEmptyCard, fsrs, generatorParameters, Rating } = await import("ts-fsrs");
    const config = fsrs(generatorParameters({ enable_fuzz: true }));
    const card = createEmptyCard();
    const now = new Date();
    const result = config.repeat(card, now)[Rating.Again];
    expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
  });
});
