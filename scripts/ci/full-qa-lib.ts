/**
 * The full-QA hold on deploys (docs/shipping.md, "Full QA and the deploy
 * hold"). Pure: the workflow runs come in as arguments, so
 * unit/full-qa-hold.test.ts drives it without GitHub.
 *
 * The full set (every qa:all suite, the extension smoke test) runs every 6 h
 * on main (.github/workflows/nightly-qa.yml, "Full QA"). While its latest
 * finished run is red, deploy-worker.yml deploys nothing — unless someone
 * overrides by hand — and a green run lifts the hold and deploys what it
 * tested.
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
 * A green full run deploys only when it lifts a hold: the decided run before
 * it was red. Otherwise every 6-hourly run would redeploy what CI already
 * deployed.
 */
export function liftsHold(runs: Run[], greenId: number): boolean {
  const ds = runs.filter(decided);
  const i = ds.findIndex((r) => r.id === greenId);
  if (i < 0 || ds[i].conclusion !== "success") return false;
  return ds[i + 1]?.conclusion === "failure";
}

/** Whether a full run is already queued or running (so a held deploy need not start one). */
export const pending = (runs: Run[]) => runs.some((r) => r.status !== "completed");

/** The newest green full run's commit: the revert goes back to it. */
export function lastGreenSha(runs: Run[]): string | null {
  return runs.find((r) => decided(r) && r.conclusion === "success")?.head_sha ?? null;
}
