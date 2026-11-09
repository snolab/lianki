/**
 * The full-QA hold on deploys (docs/shipping.md, "Full QA and the deploy
 * hold"). Pure: the workflow runs come in as arguments, so
 * unit/full-qa-hold.test.ts drives it without GitHub.
 *
 * The full set (every qa:all suite, the extension smoke test) runs on main
 * when merges call for it (.github/workflows/nightly-qa.yml, "Full QA",
 * started by full-qa-trigger.yml; decideTrigger below), never on a timer.
 * While its latest finished run is red, deploy-worker.yml deploys nothing —
 * unless someone overrides by hand — and a green run lifts the hold and
 * deploys what it tested.
 */

/** A workflow run as the REST API lists it (only the fields used here). */
export type Run = {
  id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
};

/** Finished with a verdict: cancelled and skipped runs say nothing about main. */
export const decided = (r: Run) =>
  r.status === "completed" && (r.conclusion === "success" || r.conclusion === "failure");

/** Newest first, as the API returns them. */
export function latestDecided(runs: Run[]): Run | null {
  return runs.find(decided) ?? null;
}

export type Hold = { held: false } | { held: true; run: Run };

/** Held while the newest decided full run on main failed. No run yet: open. */
export function holdState(runs: Run[]): Hold {
  const last = latestDecided(runs);
  return last?.conclusion === "failure" ? { held: true, run: last } : { held: false };
}

/**
 * A green full run deploys only when it lifts a hold: the newest decided run
 * other than itself was red. Asked from inside the green run, which is still
 * in progress then. Otherwise every routine full run would redeploy what CI
 * already deployed.
 */
export function liftsHold(runs: Run[], greenId: number): boolean {
  return holdState(runs.filter((r) => r.id !== greenId)).held;
}

/** A job of a workflow run, as the REST API lists it. */
export type Job = { name: string; status: string; conclusion: string | null };

/**
 * deploy-worker's check of a lift: the run is Full QA's, tested this commit,
 * and every one of its qa jobs (build and shards) passed.
 */
export function liftIsGenuine(
  run: { path?: string; head_sha: string },
  jobs: Job[],
  sha: string,
): string | null {
  if (!run.path?.endsWith("/nightly-qa.yml")) return "that run is not Full QA";
  if (run.head_sha !== sha)
    return `that run tested ${run.head_sha.slice(0, 7)}, not ${sha.slice(0, 7)}`;
  const qa = jobs.filter((j) => j.name.startsWith("qa / "));
  if (!qa.length) return "that run has no qa jobs";
  const bad = qa.find((j) => j.status !== "completed" || j.conclusion !== "success");
  return bad ? `${bad.name} is ${bad.conclusion ?? bad.status}` : null;
}

/** Whether a full run is already queued or running (so a held deploy need not start one). */
export const pending = (runs: Run[]) => runs.some((r) => r.status !== "completed");

/**
 * The commit main is covered up to: the newest full run that is green or still
 * queued/running (it will test that commit). A red run covers nothing, so
 * while main is red every merge counts as untested again.
 */
export function coveredSha(runs: Run[]): string | null {
  return (
    runs.find((r) => r.status !== "completed" || (decided(r) && r.conclusion === "success"))
      ?.head_sha ?? null
  );
}

/** The newest green full run's commit: the revert goes back to it. */
export function lastGreenSha(runs: Run[]): string | null {
  return runs.find((r) => decided(r) && r.conclusion === "success")?.head_sha ?? null;
}

/**
 * When a merge to main starts the full set (owner, 2026-11-10: event-driven,
 * no timer — he can be away for days, and with no merges nothing runs): a
 * debounce on merges with a max wait, plus two at-once triggers. Defaults
 * only; the live values come from repo variables of the same names (Settings
 * → Secrets and variables → Actions → Variables), which
 * .github/workflows/full-qa-trigger.yml passes in.
 */
export const FULL_QA_DEFAULTS = {
  /** Debounce: start once merges have been quiet this many minutes. */
  FULL_QA_QUIET_MIN: 15,
  /** Throttle (the debounce's max wait): merges that keep coming hold a run back at most this many hours. */
  FULL_QA_MAX_WAIT_H: 4,
  /** This many untested merges on main start a run at once. */
  FULL_QA_MAX_MERGES: 10,
} as const;

export type TriggerConfig = { quietMin: number; maxWaitH: number; maxMerges: number };

/** The config from env (repo variables), falling back to the defaults. */
export function triggerConfig(env: Record<string, string | undefined>): TriggerConfig {
  const num = (k: keyof typeof FULL_QA_DEFAULTS) => {
    const v = Number(env[k]);
    return env[k] && Number.isFinite(v) && v > 0 ? v : FULL_QA_DEFAULTS[k];
  };
  return {
    quietMin: num("FULL_QA_QUIET_MIN"),
    maxWaitH: num("FULL_QA_MAX_WAIT_H"),
    maxMerges: num("FULL_QA_MAX_MERGES"),
  };
}

export type TriggerInput = {
  /** Commits on main the last green full run did not test. */
  untested: number;
  /** A file changed since the last green run that matches a QA_FULL path, if any. */
  risky: string | null;
  /** Commit time of the oldest untested merge. */
  oldestUntestedMs: number;
  nowMs: number;
};

export type Trigger =
  | { action: "none"; reason: string }
  | { action: "now"; reason: string }
  | { action: "debounce"; reason: string; waitMin: number };

/**
 * What a push to main does. The workflow runs this in a concurrency group
 * that cancels the decision before it, so a "debounce" wait that a newer
 * merge interrupts never starts its run: that is the debounce.
 */
export function decideTrigger(i: TriggerInput, c: TriggerConfig): Trigger {
  if (i.untested <= 0)
    return { action: "none", reason: "the last green full run tested everything on main" };
  if (i.risky) return { action: "now", reason: `${i.risky} changed (a QA_FULL path)` };
  if (i.untested >= c.maxMerges)
    return {
      action: "now",
      reason: `${i.untested} merges since the last green full run (at least ${c.maxMerges})`,
    };
  if ((i.nowMs - i.oldestUntestedMs) / 3_600_000 >= c.maxWaitH)
    return {
      action: "now",
      reason: `the oldest untested merge has waited ${c.maxWaitH} h while merges kept coming`,
    };
  return {
    action: "debounce",
    reason: `${i.untested} untested merge(s): run once merges are quiet for ${c.quietMin} min`,
    waitMin: c.quietMin,
  };
}
