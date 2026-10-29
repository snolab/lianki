import { describe, expect, test } from "bun:test";
import {
  PROBE_SLOW_MS,
  PROBE_STRIKES,
  WINDOW_MS,
  inWindow,
  nextStrikes,
  pathGroup,
  probeBad,
  secs,
} from "../workers/monitor/src/rules";

test("secs: one decimal", () => {
  expect(secs(1234)).toBe("1.2s");
});

describe("probeBad", () => {
  test("fast 200 is fine; 5xx, failures and slowness are not", () => {
    expect(probeBad({ path: "/home", status: 200, ms: 120 })).toBeNull();
    expect(probeBad({ path: "/home", status: 503, ms: 50 })).toBe("HTTP 503");
    expect(probeBad({ path: "/home", status: 0, ms: 0, error: "timeout" })).toBe("failed: timeout");
    expect(probeBad({ path: "/home", status: 200, ms: PROBE_SLOW_MS + 400 })).toBe("slow: 3.4s");
  });
  test("a 4xx is the page's answer, not an outage", () => {
    expect(probeBad({ path: "/x", status: 404, ms: 80 })).toBeNull();
  });
});

describe("nextStrikes", () => {
  test("alerts once, on the strike that reaches the threshold", () => {
    let s = 0;
    const alerts: boolean[] = [];
    for (let k = 0; k < PROBE_STRIKES + 2; k++) {
      const r = nextStrikes(s, true);
      s = r.strikes;
      alerts.push(r.alert);
    }
    expect(alerts.filter(Boolean)).toHaveLength(1);
    expect(alerts[PROBE_STRIKES - 1]).toBe(true);
  });
  test("recovery is announced only after an alert", () => {
    expect(nextStrikes(1, false)).toEqual({ strikes: 0, alert: false, recovered: false });
    expect(nextStrikes(PROBE_STRIKES, false).recovered).toBe(true);
  });
});

describe("inWindow", () => {
  test("drops what fell out of the window", () => {
    const now = WINDOW_MS + 5;
    expect(inWindow([0, 4, 10], now, now)).toEqual([10, now]);
    expect(inWindow([10], 20, 30)).toEqual([10, 20]);
  });
});

describe("pathGroup", () => {
  test("collapses ids so paths aggregate", () => {
    expect(
      pathGroup("https://lianki.com/api/words/lists/b6030131-b227-4703-b2e6-b7113f1c0768/review"),
    ).toBe("/api/words/lists/:id/review");
    expect(pathGroup("https://lianki.com/home?x=1")).toBe("/home");
    expect(pathGroup("not a url")).toBe("?");
  });
});
