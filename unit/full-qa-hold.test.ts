import { describe, expect, test } from "bun:test";
import {
  FULL_QA_DEFAULTS,
  coveredSha,
  decideTrigger,
  holdState,
  lastGreenSha,
  latestDecided,
  liftIsGenuine,
  liftsHold,
  pending,
  triggerConfig,
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

describe("liftsHold (asked from inside the green run, still in progress)", () => {
  test("the newest decided run before it was red: lifts", () => {
    const me = r(null, "in_progress");
    expect(liftsHold([me, r("cancelled"), r("failure"), r("success")], me.id)).toBe(true);
  });
  test("the one before was green, or there is none: nothing to lift", () => {
    const me = r(null, "in_progress");
    expect(liftsHold([me, r("success"), r("failure")], me.id)).toBe(false);
    expect(liftsHold([me], me.id)).toBe(false);
  });
});

describe("liftIsGenuine (deploy-worker's check)", () => {
  const run = { path: ".github/workflows/nightly-qa.yml", head_sha: "abc1234def" };
  const ok = (name: string) => ({ name, status: "completed", conclusion: "success" });
  const jobs = [ok("qa / qa build"), ok("qa / qa:all 1/3"), ok("On green: lift the deploy hold")];
  test("Full QA's run, this commit, every qa job green", () => {
    expect(liftIsGenuine(run, jobs, "abc1234def")).toBeNull();
  });
  test("refuses another workflow, another commit, no qa, a red or unfinished qa job", () => {
    expect(liftIsGenuine({ ...run, path: ".github/workflows/ci.yml" }, jobs, "abc1234def")).toMatch(
      /not Full QA/,
    );
    expect(liftIsGenuine(run, jobs, "fff")).toMatch(/not fff/);
    expect(liftIsGenuine(run, [], "abc1234def")).toMatch(/no qa jobs/);
    expect(
      liftIsGenuine(
        run,
        [...jobs, { name: "qa / qa:all 2/3", status: "completed", conclusion: "failure" }],
        "abc1234def",
      ),
    ).toMatch(/2\/3 is failure/);
    expect(
      liftIsGenuine(
        run,
        [{ name: "qa / qa:all 3/3", status: "in_progress", conclusion: null }],
        "abc1234def",
      ),
    ).toMatch(/in_progress/);
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

describe("coveredSha", () => {
  test("a running run covers its commit; a red one covers nothing", () => {
    expect(coveredSha([r("failure"), r(null, "in_progress", "run"), r("success")])).toBe("run");
    expect(coveredSha([r("failure"), r("cancelled"), r("success", "completed", "g")])).toBe("g");
    expect(coveredSha([r("failure")])).toBeNull();
  });
});

describe("decideTrigger (no timer: debounce, max wait, risky, count)", () => {
  const c = triggerConfig({});
  const now = 10 * 3_600_000;
  const base = { untested: 2, risky: null, oldestUntestedMs: now - 60_000, nowMs: now };
  test("defaults, and repo variables override them", () => {
    expect(c).toEqual({
      quietMin: FULL_QA_DEFAULTS.FULL_QA_QUIET_MIN,
      maxWaitH: FULL_QA_DEFAULTS.FULL_QA_MAX_WAIT_H,
      maxMerges: FULL_QA_DEFAULTS.FULL_QA_MAX_MERGES,
    });
    expect(
      triggerConfig({ FULL_QA_QUIET_MIN: "5", FULL_QA_MAX_WAIT_H: "x", FULL_QA_MAX_MERGES: "-1" }),
    ).toEqual({ ...c, quietMin: 5 });
  });
  test("nothing untested: nothing runs", () => {
    expect(decideTrigger({ ...base, untested: 0 }, c).action).toBe("none");
  });
  test("a QA_FULL path: at once", () => {
    expect(decideTrigger({ ...base, risky: "wrangler.jsonc" }, c).action).toBe("now");
  });
  test("enough merges: at once", () => {
    expect(decideTrigger({ ...base, untested: c.maxMerges }, c).action).toBe("now");
  });
  test("the oldest untested merge waited the max: at once", () => {
    const t = decideTrigger({ ...base, oldestUntestedMs: now - c.maxWaitH * 3_600_000 }, c);
    expect(t.action).toBe("now");
  });
  test("otherwise: wait for merges to be quiet", () => {
    expect(decideTrigger(base, c)).toEqual({
      action: "debounce",
      reason: expect.any(String),
      waitMin: c.quietMin,
    });
  });
});
