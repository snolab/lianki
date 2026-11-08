/**
 * The arguments of scripts/dev/progress.ts, parsed into what it sends.
 * Kept apart from the CLI so it is unit-tested without the network.
 */
import {
  PROGRESS_KINDS,
  PROGRESS_STATUSES,
  type ProgressAgentStats,
  type ProgressReport,
  checkTaskTitle,
  isProgressId,
  parseProgressReport,
  parseTtl,
} from "../../lib/progress";

export const PROGRESS_USAGE = `usage:
  bun scripts/dev/progress.ts --agent <name> --task "<name>: <description>" --status <${PROGRESS_STATUSES.join("|")}>
      [--path /words/prefetch | --id <slug> [--parent <id>]] [--done] [--pct 40] [--eta 15m]
      [--pr 299] [--note "..."] [--needs "approve PR #299"] [--kind <${PROGRESS_KINDS.join("|")}>]
      [--ref <id>] [--action "<command or URL>"] [--link https://…] [--rev N] [--human]
  bun scripts/dev/progress.ts grant --node <id> --agent <name> [--ttl 8h]
  bun scripts/dev/progress.ts resolve --id <id> [--note "the answer"]
  bun scripts/dev/progress.ts show
  bun scripts/dev/progress.ts stats [--agent <name>] [--since 7d]
--task is "name: description" (':' or '：'): a short name (1–20 characters), then what it is.
The owner's ETA bar shows only the name; the full list shows both. A name over 20 characters is
refused; a title with no colon is taken, with a warning when it is over 20.
  e.g. --task "Swipe fix: the card snaps back on a short drag"
--eta is your own estimate, given each time: a duration from now (15m, 1h30m, 2h) or an ISO time
(2026-11-07T21:00+09:00). It sets the node's etaAt: the owner's chat shows a bar running to it, and
when it passes the agents get one automatic line "ETA reached for <task> (<id>): report to the owner".
Report again with a new --eta to move it; free text ("after CI") shows as written, with no timer.
The hub also keeps, for agents only (never shown to the owner), each task's first estimate, start,
end and actual time; "stats" lists your done tasks (30 days) with estimate vs actual and the
median actual/estimate ratio, to calibrate your next --eta.
Every form takes --token <token> (else LIANKI_PROGRESS_TOKEN, PROGRESS_TOKEN, or .dev.vars).`;

export type ProgressCommand = { token?: string } & (
  | { cmd: "report"; report: ProgressReport; warning?: string }
  | { cmd: "grant"; node: string; agent: string; ttl: string }
  | { cmd: "resolve"; id: string; note?: string }
  | { cmd: "show" }
  | { cmd: "stats"; agent?: string; since: number }
);

/** `stats` without --since: the last week. */
export const STATS_SINCE_DEFAULT = "7d";

const STRINGS = [
  "agent",
  "task",
  "status",
  "eta",
  "note",
  "id",
  "parent",
  "path",
  "needs",
  "kind",
  "ref",
  "action",
  "link",
  "token",
  "node",
  "ttl",
  "since",
] as const;
const NUMBERS = ["pct", "pr", "rev"] as const;
const SWITCHES = ["done", "human"] as const;

/** argv (without the runtime and script) → the command, or an Error naming what is wrong. */
export function parseProgressArgs(argv: string[]): ProgressCommand | Error {
  const sub = ["grant", "resolve", "show", "stats"].includes(argv[0] ?? "") ? argv[0]! : "report";
  const raw: Record<string, unknown> = {};
  for (let i = sub === "report" ? 0 : 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
    if (!m) return new Error(`unexpected argument: ${arg}`);
    const name = m[1]!;
    if ((SWITCHES as readonly string[]).includes(name)) {
      raw[name] = true;
      continue;
    }
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
  const token = typeof raw.token === "string" ? { token: raw.token } : {};
  if (sub === "show") return { cmd: "show", ...token };
  if (sub === "stats") {
    const since = parseTtl(typeof raw.since === "string" ? raw.since : STATS_SINCE_DEFAULT);
    if (since instanceof Error) return new Error(`--since: ${since.message}`);
    return {
      cmd: "stats",
      since,
      ...(typeof raw.agent === "string" && raw.agent ? { agent: raw.agent } : {}),
      ...token,
    };
  }
  if (sub === "grant") {
    if (!isProgressId(raw.node)) return new Error("grant needs --node <id>");
    if (typeof raw.agent !== "string" || !raw.agent) return new Error("grant needs --agent <name>");
    const ttl = typeof raw.ttl === "string" ? raw.ttl : "8h";
    const ms = parseTtl(ttl);
    if (ms instanceof Error) return new Error(`--ttl: ${ms.message}`);
    return { cmd: "grant", node: raw.node, agent: raw.agent, ttl, ...token };
  }
  if (sub === "resolve") {
    if (!isProgressId(raw.id)) return new Error("resolve needs --id <id>");
    return {
      cmd: "resolve",
      id: raw.id,
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      ...token,
    };
  }
  if (raw.done) raw.status = "done";
  if (raw.path !== undefined) {
    if (raw.id !== undefined && raw.id !== raw.path) return new Error("--path and --id differ");
    raw.id = raw.path;
  }
  if (raw.human) {
    raw.assignee = { type: "human", name: raw.agent };
    delete raw.agent;
  }
  for (const k of ["path", "done", "human", "token"]) delete raw[k];
  const report = parseProgressReport(raw);
  if (report instanceof Error) return report;
  const title = checkTaskTitle(report.task);
  if (title instanceof Error) return title;
  return { cmd: "report", report, ...(title.warning ? { warning: title.warning } : {}), ...token };
}

const mins = (ms: number) =>
  ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;

/** `stats` for a terminal: per agent the median ratio, then one line per done task. */
export function formatStats(stats: ProgressAgentStats[]): string {
  if (!stats.length) return "progress: no done tasks in that window";
  return stats
    .map((a) => {
      const ratio =
        a.medianRatio === undefined ? "no estimates" : `median ×${a.medianRatio.toFixed(2)}`;
      const head = `${a.agent}: ${a.done} done, ${a.estimated} estimated, ${ratio}`;
      const rows = a.tasks.map((d) => {
        const est = d.estimateMs ? mins(d.estimateMs) : "—";
        const x = d.estimateMs ? ` ×${(d.actualMs / d.estimateMs).toFixed(2)}` : "";
        const rev = d.revisions ? `, ${d.revisions} revised` : "";
        return `  ${d.id}  est ${est} → actual ${mins(d.actualMs)}${x}${rev}  ${d.title}`;
      });
      return [head, ...rows].join("\n");
    })
    .join("\n");
}
