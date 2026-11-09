/**
 * The arguments of scripts/dev/progress.ts, parsed into what it sends.
 * Kept apart from the CLI so it is unit-tested without the network.
 */
import { readFileSync } from "node:fs";
import {
  CHANGE_ID_RE,
  PROGRESS_KINDS,
  PROGRESS_STATUSES,
  type ProgressAgentStats,
  type ProgressHistory,
  type ProgressReport,
  checkTaskTitle,
  isProgressId,
  parseProgressReport,
  parseTtl,
} from "../../lib/progress";

export const PROGRESS_USAGE = `usage:
  bun scripts/dev/progress.ts --agent <name> --task "<name>: <description>" --status <${PROGRESS_STATUSES.join("|")}>
      [--path /words/prefetch | --id <slug> [--parent <id>]] [--done] [--pct 40]
      [--eta 15m | --eta 12m-63m [--late "why"] | --confirm] [--change-id <id>]
      [--pr 299] [--note "..."] [--needs "approve PR #299"] [--kind <${PROGRESS_KINDS.join("|")}>]
      [--ref <id>] [--action "<command or URL>"] [--link https://…] [--rev N] [--human]
  bun scripts/dev/progress.ts batch [--change-id <id>] '<JSON list of reports>' | --file <path.json>
  bun scripts/dev/progress.ts grant --node <id> --agent <name> [--ttl 8h]
  bun scripts/dev/progress.ts resolve --id <id> [--note "the answer"]
  bun scripts/dev/progress.ts show [--all]
  bun scripts/dev/progress.ts history [--agent <name>] [--since 30d] [--limit 500] [--json]
  bun scripts/dev/progress.ts stats [--agent <name>] [--since 7d]
--task is "name: description" (':' or '：'): a short name (1–20 characters), then what it is.
The owner's ETA bar shows only the name; the full list shows both. A name over 20 characters is
refused; a title with no colon is taken, with a warning when it is over 20.
  e.g. --task "Swipe fix: the card snaps back on a short drag"
--eta is your own estimate, given each time: a duration from now (15m, 1h30m, 2h), a range
12m-63m (P5–P95 of what it may take: shown "12–63M"; overdue, the ping and the overrun rule count
from the P95) or an ISO time (2026-11-07T21:00+09:00). It sets the node's etaAt: the owner's chat
shows a bar running to it, and when it passes the owning lane gets one automatic line "ETA reached
for <task> (<id>)…".
--confirm re-confirms the estimate unchanged (before it runs out): the hub logs it, and "show"
gives the node's etaConfirmedAt and "etaConfirmedAgo", so a stale estimate stands out.
One action across several nodes shares a change id and one time, so the Gantt's ticks line up:
  batch '[{"agent":"a","path":"/x/a","task":"A: …","eta":"20m"},{"agent":"a","path":"/x/b","task":"B: …","eta":"1h"}]'
(each item takes this command's flags as keys; true for a switch), or --change-id <id> on each call.
ETA overrun (standing rule): a task past its ETA and not done must, within 5 minutes, tell the owner
WHY and a new "N minutes from now", in one call:
  --eta 20m --late "CI queue was slow"      (the hub posts the reason and the new time in Li)
Once the ETA has passed, a new --eta without --late is refused. No reason or new ETA within
5 minutes: the owner is told "<name> 超时，未说明原因".
Report again with a new --eta to move it; free text ("after CI") shows as written, with no timer.
The hub also keeps, for agents only (never shown to the owner), each task's first estimate, start,
end and actual time; "stats" lists your done tasks (30 days) with estimate vs actual and the
median actual/estimate ratio, to calibrate your next --eta.
--ended <ISO time> (root token only, with --done): when old work really shipped, moving it into the tree.
--pr takes one number or several (--pr 703,707); a node keeps every PR it ever named.
"history" lists done nodes, newest first, from the hub's durable done history (kept after the live
tree drops a done node at 24 h); "show --all" is the tree with that history under "history".
Every form takes --token <token> (else LIANKI_PROGRESS_TOKEN, PROGRESS_TOKEN, or .dev.vars).`;

export type ProgressCommand = { token?: string } & (
  | { cmd: "report"; report: ProgressReport; warning?: string }
  | { cmd: "batch"; reports: ProgressReport[]; changeId?: string; warnings: string[] }
  | { cmd: "grant"; node: string; agent: string; ttl: string }
  | { cmd: "resolve"; id: string; note?: string }
  | { cmd: "show"; all?: boolean }
  | { cmd: "history"; agent?: string; since?: number; limit?: number; json?: boolean }
  | { cmd: "stats"; agent?: string; since: number }
);

/** `stats` without --since: the last week. */
export const STATS_SINCE_DEFAULT = "7d";

const STRINGS = [
  "agent",
  "task",
  "status",
  "eta",
  "late",
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
  "ended",
  "change-id",
  "file",
] as const;
const NUMBERS = ["pct", "pr", "rev", "limit"] as const;
const SWITCHES = ["done", "human", "all", "json", "confirm"] as const;
const SUBS = ["grant", "resolve", "show", "stats", "history", "batch"];

/**
 * `batch`'s list: each item an object keyed by this command's flags
 * ({"agent": "a", "path": "/x", "eta": "20m", "confirm": true}), parsed as
 * that report's flags would be. An Error names the first bad item.
 */
export function parseBatchItems(
  items: unknown,
): { reports: ProgressReport[]; warnings: string[] } | Error {
  if (!Array.isArray(items) || !items.length)
    return new Error("batch needs a JSON list of reports");
  const reports: ProgressReport[] = [];
  const warnings: string[] = [];
  for (const [i, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return new Error(`batch item ${i}: not an object`);
    const argv: string[] = [];
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "token" || k === "change-id" || k === "changeId")
        return new Error(`batch item ${i}: ${k} goes on the batch, not an item`);
      argv.push(`--${k}`);
      if (v !== true) argv.push(String(v));
    }
    const cmd = parseProgressArgs(argv);
    if (cmd instanceof Error) return new Error(`batch item ${i}: ${cmd.message}`);
    if (cmd.cmd !== "report") return new Error(`batch item ${i}: not a report`);
    reports.push(cmd.report);
    if (cmd.warning) warnings.push(`item ${i}: ${cmd.warning}`);
  }
  return { reports, warnings };
}

/** argv (without the runtime and script) → the command, or an Error naming what is wrong. */
export function parseProgressArgs(argv: string[]): ProgressCommand | Error {
  const sub = SUBS.includes(argv[0] ?? "") ? argv[0]! : "report";
  const raw: Record<string, unknown> = {};
  for (let i = sub === "report" ? 0 : 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(arg);
    if (!m && sub === "batch" && raw.list === undefined) {
      raw.list = arg;
      continue;
    }
    if (!m) return new Error(`unexpected argument: ${arg}`);
    const name = m[1]!;
    if ((SWITCHES as readonly string[]).includes(name)) {
      raw[name] = true;
      continue;
    }
    const value = m[2] ?? argv[++i];
    if (value === undefined) return new Error(`--${name} needs a value`);
    if ((STRINGS as readonly string[]).includes(name)) raw[name] = value;
    else if (name === "pr" && value.includes(",")) {
      const prs = value.split(",").map((v) => Number(v.trim().replace(/^#/, "")));
      if (!prs.every((n) => Number.isInteger(n) && n > 0))
        return new Error("--pr must be a number or numbers separated by commas");
      raw.prs = prs;
    } else if ((NUMBERS as readonly string[]).includes(name)) {
      const n = Number(value.replace(/^#|%$/g, ""));
      if (value.trim() === "" || !Number.isFinite(n))
        return new Error(`--${name} must be a number`);
      raw[name] = n;
    } else return new Error(`unknown flag: --${name}`);
  }
  const token = typeof raw.token === "string" ? { token: raw.token } : {};
  const changeId = raw["change-id"];
  if (changeId !== undefined && (typeof changeId !== "string" || !CHANGE_ID_RE.test(changeId)))
    return new Error("--change-id must be 1–40 of A-Z a-z 0-9 . _ : -");
  if (sub === "batch") {
    let list: unknown;
    try {
      const text =
        typeof raw.file === "string"
          ? readFileSync(raw.file, "utf8")
          : typeof raw.list === "string"
            ? raw.list
            : undefined;
      if (text === undefined) return new Error("batch needs '<JSON list>' or --file <path>");
      list = JSON.parse(text);
    } catch (e) {
      return new Error(`batch: ${e instanceof Error ? e.message : String(e)}`);
    }
    const got = parseBatchItems(list);
    if (got instanceof Error) return got;
    return {
      cmd: "batch",
      ...got,
      ...(typeof changeId === "string" ? { changeId } : {}),
      ...token,
    };
  }
  if (typeof changeId === "string") raw.changeId = changeId;
  delete raw["change-id"];
  if (sub === "show") return { cmd: "show", ...(raw.all ? { all: true } : {}), ...token };
  if (sub === "history") {
    const since = typeof raw.since === "string" ? parseTtl(raw.since) : undefined;
    if (since instanceof Error) return new Error(`--since: ${since.message}`);
    return {
      cmd: "history",
      ...(typeof raw.agent === "string" && raw.agent ? { agent: raw.agent } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(typeof raw.limit === "number" && raw.limit > 0 ? { limit: raw.limit } : {}),
      ...(raw.json ? { json: true } : {}),
      ...token,
    };
  }
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
  if (typeof raw.ended === "string") {
    const at = Date.parse(raw.ended);
    if (!Number.isFinite(at)) return new Error("--ended must be an ISO time");
    raw.endedAt = at;
  }
  if (raw.path !== undefined) {
    if (raw.id !== undefined && raw.id !== raw.path) return new Error("--path and --id differ");
    raw.id = raw.path;
  }
  if (raw.human) {
    raw.assignee = { type: "human", name: raw.agent };
    delete raw.agent;
  }
  for (const k of [
    "path",
    "done",
    "human",
    "token",
    "all",
    "json",
    "limit",
    "ended",
    "file",
    "list",
  ])
    delete raw[k];
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

const jst = (at: number) =>
  new Date(at + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

/**
 * `history` for a terminal: one line per done node (JST end time, id, PRs,
 * title), filtered by agent and by `since` (ms back from `now`).
 */
export function formatHistory(
  items: ProgressHistory[],
  opts: { agent?: string; since?: number; now?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const rows = items.filter(
    (h) =>
      (!opts.agent || h.agent === opts.agent) &&
      (opts.since === undefined || h.endedAt >= now - opts.since),
  );
  if (!rows.length) return "progress: no done nodes in the history for that filter";
  return rows
    .map((h) => {
      const prs = h.prs?.length ? `  ${h.prs.map((n) => `#${n}`).join(" ")}` : "";
      return `${jst(h.endedAt)} JST  ${h.id}${prs}  ${h.title}  (${h.agent})`;
    })
    .join("\n");
}
