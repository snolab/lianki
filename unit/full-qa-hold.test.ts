import { describe, expect, test } from "bun:test";
import {
  holdState,
  lastGreenSha,
  latestDecided,
  liftsHold,
  pending,
  type Run,
} from "../scripts/ci/full-qa-lib";

let n = 100;
const r = (conclusion: string | null, status = "completed", sha = `sha${n}`): Run => ({
  id: n--,
  head_sha: sha,
  status,
  conclusion,
  html_url: `https://example.test/${n}`,
  created_at: "2026-11-10T00:00:00Z",
});

describe("holdState", () => {
  test("no runs: open", () => expect(holdState([])).toEqual({ held: false }));
  test("newest decided green: open", () => {
    expect(holdState([r(null, "in_progress"), r("success"), r("failure")]).held).toBe(false);
  });
  test("newest decided red: held, cancelled runs skipped", () => {
    const red = r("failure");
    const h = holdState([r("cancelled"), red, r("success")]);
    expect(h).toEqual({ held: true, run: red });
  });
  test("latestDecided skips skipped", () => {
    const g = r("success");
    expect(latestDecided([r("skipped"), g])).toBe(g);
  });
});

describe("liftsHold", () => {
  test("green after red lifts", () => {
    const g = r("success");
    expect(liftsHold([g, r("cancelled"), r("failure")], g.id)).toBe(true);
  });
  test("green after green does not", () => {
    const g = r("success");
    expect(liftsHold([g, r("success")], g.id)).toBe(false);
  });
  test("first ever, unknown or red run does not", () => {
    const g = r("success");
    expect(liftsHold([g], g.id)).toBe(false);
    expect(liftsHold([g], 1)).toBe(false);
    const red = r("failure");
    expect(liftsHold([red, r("failure")], red.id)).toBe(false);
  });
});

describe("pending and lastGreenSha", () => {
  test("pending sees a queued run", () => {
    expect(pending([r(null, "queued")])).toBe(true);
    expect(pending([r("success")])).toBe(false);
  });
  test("lastGreenSha: the newest green", () => {
    expect(lastGreenSha([r("failure"), r("success", "completed", "abc"), r("success")])).toBe(
      "abc",
    );
    expect(lastGreenSha([r("failure")])).toBeNull();
  });
});
