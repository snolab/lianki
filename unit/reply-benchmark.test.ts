import { describe, expect, it } from "bun:test";
import { replyBenchmark } from "../scripts/dev/reply-benchmark-lib";

const opts = { thresholdMs: 5000, windowMs: 30000, observedAt: 40000 };
const own = (at: number, text = "@coco check", source?: string, thread?: string) => ({
  from: "owner",
  at,
  text,
  source,
  thread,
});
const agent = (at: number, lane = "codex", text = "answer", thread?: string) => ({
  from: "agent",
  at,
  lane,
  text,
  thread,
});

describe("historical reply benchmark", () => {
  it("splits typed/STT and same lane, excludes ambient and automatic receipts", () => {
    const r = replyBenchmark(
      [
        own(1000, "ambient room speech"),
        own(2000),
        agent(2100, "agy"),
        agent(2200, "codex", "【coco】收到 ✓ check"),
        agent(4000),
        own(5000, "@coco next", "stt"),
        agent(11000),
        own(12000, "Li, help"),
        agent(13000, "main"),
      ],
      opts,
    );
    expect(r.counts.ambient).toBe(1);
    expect(r.counts.automatic).toBe(1);
    expect(r.groups.find((g) => g.lane === "codex" && g.source === "typed")).toMatchObject({
      matched: 1,
      p50Ms: 2000,
      overTarget: 0,
    });
    expect(r.groups.find((g) => g.source === "stt")).toMatchObject({
      matched: 1,
      p90Ms: 6000,
      overTarget: 1,
    });
    expect(r.groups.find((g) => g.lane === "main")).toMatchObject({ matched: 1, p50Ms: 1000 });
  });
  it("never reuses one reply as several clean samples", () => {
    const r = replyBenchmark([own(1000), own(2000, "@coco two", "stt"), agent(4000)], opts);
    expect(r.counts.batches).toBe(1);
    expect(r.groups.every((g) => g.batched === 1 && g.matched === 0 && g.p50Ms === null)).toBe(
      true,
    );
  });
  it("separates expiry, censoring, thread isolation and snapshot edges", () => {
    const r = replyBenchmark(
      [
        own(1000),
        own(2000, "@coco check", undefined, "child"),
        agent(35000),
        own(36000),
        own(30000, "@小克 hi"),
      ],
      opts,
    );
    expect(r.groups.find((g) => g.lane === "codex")).toMatchObject({
      requests: 3,
      expired: 2,
      censored: 1,
      matched: 0,
    });
    expect(r.groups.find((g) => g.lane === "claude")).toMatchObject({
      censored: 1,
      censoredOverTarget: 1,
    });
  });
  it("accepts ISO dates, sorts input, resolves known agent labels, never outputs text or IDs", () => {
    const r = replyBenchmark(
      [
        {
          from: "agent",
          at: "1970-01-01T00:00:03Z",
          text: "private-response",
          label: "coco",
          id: "private-id",
        },
        { ...own(1000), at: "1970-01-01T00:00:01Z", text: "@coco private-request" },
        { from: "agent", at: 4000, label: "Li", text: "private-li" },
        own(5000, "@Li hello"),
        { from: "agent", at: 6000, agentId: "li", text: "ok" },
        { from: "agent", at: 7000, text: "unknown", label: "lk_private-secret" },
      ],
      opts,
    );
    expect(r.groups.find((g) => g.lane === "codex")).toMatchObject({ p50Ms: 2000 });
    expect(r.counts.unknownAgents).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/private-/);
  });
  it("counts malformed/future/unknown source inputs without emitting them", () => {
    const r = replyBenchmark(
      [
        null,
        [],
        { at: NaN },
        own(50000),
        own(1000, "@coco hi", "eta"),
        { from: "friend", at: 2000, text: "not owner" },
        { ...agent(3000), source: "eta" },
        { ...agent(4000), laneEvent: {} },
      ],
      opts,
    );
    expect(r.counts.invalid).toBe(5);
    expect(r.groups).toEqual([]);
    for (const bad of [{ thresholdMs: -1 }, { windowMs: 0 }, { observedAt: NaN }])
      expect(() => replyBenchmark([], { ...opts, ...bad })).toThrow();
  });
  it("reports percentile tails and expires requests before matching a later request", () => {
    const r = replyBenchmark([own(0), own(31000), agent(32000), own(33000), agent(40000)], {
      ...opts,
      observedAt: 40000,
    });
    expect(r.groups[0]).toMatchObject({
      expired: 1,
      matched: 2,
      p50Ms: 1000,
      p90Ms: 7000,
      maxMs: 7000,
      overTarget: 1,
    });
  });
});
