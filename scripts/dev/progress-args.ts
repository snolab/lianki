/**
 * The arguments of scripts/dev/progress.ts, parsed into the report it posts.
 * Kept apart from the CLI so it is unit-tested without the network.
 */
import {
  PROGRESS_KINDS,
  PROGRESS_STATUSES,
  type ProgressReport,
  parseProgressReport,
} from "../../lib/progress";

export const PROGRESS_USAGE = `usage: bun scripts/dev/progress.ts --agent <name> --task "<text>" --status <${PROGRESS_STATUSES.join("|")}>
       [--done] [--pct 40] [--eta 15m] [--pr 299] [--note "..."]
       [--id <slug>] [--parent <slug>] [--needs "approve PR #299"] [--kind <${PROGRESS_KINDS.join("|")}>]`;

const STRINGS = [
  "agent",
  "task",
  "status",
  "eta",
  "note",
  "id",
  "parent",
  "needs",
  "kind",
] as const;
const NUMBERS = ["pct", "pr"] as const;

/** argv (without the runtime and script) → the report, or an Error naming what is wrong. */
export function parseProgressArgs(argv: string[]): ProgressReport | Error {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--done") {
      raw.status = "done";
      continue;
    }
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
    if (!m) return new Error(`unexpected argument: ${arg}`);
    const name = m[1];
    const value = m[2] ?? argv[++i];
    if (value === undefined) return new Error(`--${name} needs a value`);
    if ((STRINGS as readonly string[]).includes(name)) raw[name] = value;
    else if ((NUMBERS as readonly string[]).includes(name)) {
      const n = Number(value.replace(/^#|%$/g, ""));
      if (value.trim() === "" || !Number.isFinite(n))
        return new Error(`--${name} must be a number`);
      raw[name] = n;
    } else return new Error(`unknown flag: --${name}`);
  }
  return parseProgressReport(raw);
}
