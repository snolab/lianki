/**
 * Which state tree node a shipped commit belongs to, and the report that
 * puts the PR on it (docs/planning-tools.md, step 5; docs/shipping.md,
 * "The PR on its node"). Kept apart from scripts/ship.ts so it is unit-tested
 * without git, gh or the network.
 *
 * The node, first found wins:
 *   1. `--node /path` on the ship.ts command line
 *   2. LIANKI_TASK_PATH (the lane's node, as eval.ts reads it)
 *   3. a `Tree: /path` line in the commit message (the same line design docs
 *      carry at their top)
 * None: the PR is not attached, and ship.ts says so.
 */
import { type ProgressEntry, isPathId, isProgressId } from "../lib/progress";

/** A `Tree: /path` line, at the start of a line (commit messages, design docs). */
export const TREE_LINE = /^Tree:\s*(\/\S+)\s*$/m;

/** The node path in a text's `Tree: /path` line, or null. */
export function treeLine(text: string): string | null {
  const m = TREE_LINE.exec(text);
  return m && isProgressId(m[1]) && isPathId(m[1]!) ? m[1]! : null;
}

export type ShipNodeSource = "flag" | "env" | "commit";

/** The node a ship belongs to, and where it was found; null when nothing names one. */
export function shipNode(opts: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  commitMessage: string;
}): { path: string; from: ShipNodeSource } | { error: string } | null {
  const i = opts.argv.indexOf("--node");
  const flag = i >= 0 ? opts.argv[i + 1] : opts.argv.find((a) => a.startsWith("--node="))?.slice(7);
  const check = (path: string, from: ShipNodeSource) =>
    isProgressId(path) && isPathId(path)
      ? { path, from }
      : { error: `not a node path: ${path} (a /path of a-z, 0-9, . _ : -)` };
  if (i >= 0 && !flag) return { error: "--node needs a /path" };
  if (flag) return check(flag, "flag");
  const env = opts.env.LIANKI_TASK_PATH?.trim();
  if (env) return check(env, "env");
  const line = treeLine(opts.commitMessage);
  return line ? { path: line, from: "commit" } : null;
}

/**
 * The report that adds PR `pr` to `node`, keeping its title and status. The
 * writer is LIANKI_AGENT when set (a scoped token writes as its own agent),
 * else the node's creator.
 */
export function prReport(
  node: Pick<ProgressEntry, "id" | "task" | "status" | "creator">,
  pr: number,
  agent?: string,
): Record<string, unknown> {
  return {
    id: node.id,
    agent: agent?.trim() || node.creator,
    task: node.task,
    status: node.status,
    pr,
    note: `PR #${pr} opened by ship.ts`,
  };
}
