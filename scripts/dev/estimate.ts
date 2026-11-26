#!/usr/bin/env bun
/**
 * The estimate skill's CLI (.agents/skills/estimate/SKILL.md): a P5/P50/P95
 * for a task from the state tree's done history, calibrated by a local log
 * of past estimates and their actuals. The maths is lib/estimate.
 *
 *   bun scripts/dev/estimate.ts "Fix the Gantt label overlap" --kind ui-fix --lane claude [--node /dev/gantt-label]
 *   bun scripts/dev/estimate.ts "…" --guess 2h          # fold in my own guess (scaled by my bias)
 *   bun scripts/dev/estimate.ts "…" --eta-only          # just "12m-1h5m", for --eta
 *   bun scripts/dev/estimate.ts close <id> [--actual 40m]   # record what it really took
 *   bun scripts/dev/estimate.ts sync                    # close open estimates whose node went done
 *   bun scripts/dev/estimate.ts stats [--lane claude]   # coverage and median ratio per kind
 *
 * The log is LIANKI_ESTIMATES_LOG, else ~/.config/lianki/estimates.jsonl:
 * local, never committed. The history comes from the progress hub with the
 * progress token (as progress.ts). Every run first syncs closes from it.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  ESTIMATE_KINDS,
  type Estimate,
  type HistoryLike,
  type LogClose,
  type LogEstimate,
  type LogRecord,
  calibrationStats,
  closesFromHistory,
  estimate,
  etaRange,
  foldLog,
  formatDuration,
  isEstimateKind,
  newEstimateId,
  samplesFromHistory,
} from "../../lib/estimate";
import { parseEta } from "../../lib/progress";
import { BASE } from "./eval-socket";
import { postProgress, progressToken } from "./progress-client";
import { findAutoEta, parseProgressArgs, replaceAutoEta } from "./progress-args";

export const ESTIMATE_USAGE = `usage:
  bun scripts/dev/estimate.ts "<task>" [--kind <${ESTIMATE_KINDS.join("|")}>] [--tags a,b]
      [--lane <you>] [--node /path] [--guess 2h] [--json | --eta-only] [--no-log]
  bun scripts/dev/estimate.ts close <id> [--actual 40m]   (no --actual: now − when it was made)
  bun scripts/dev/estimate.ts sync
  bun scripts/dev/estimate.ts stats [--lane <you>] [--json]
--kind is guessed from the task when not given. --lane defaults to LIANKI_LANE, else "unknown".
The answer is P5/P50/P95 and the --eta range to pass to progress.ts (or use --eta auto there).`;

export const logPath = () =>
  process.env.LIANKI_ESTIMATES_LOG || join(homedir(), ".config", "lianki", "estimates.jsonl");

export function readLog(path = logPath()): LogRecord[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as LogRecord;
      if (r && (r.type === "estimate" || r.type === "close")) out.push(r);
    } catch {}
  }
  return out;
}

export function appendLog(records: readonly LogRecord[], path = logPath()) {
  if (!records.length) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
}

/** The done history from the hub; [] (with a warning) when it cannot be read. */
export async function fetchHistory(token?: string): Promise<HistoryLike[]> {
  const t = progressToken(token);
  if (!t) {
    console.error("estimate: no progress token: priors and the local log only");
    return [];
  }
  const res = await postProgress(BASE, t, "/history?limit=2000");
  if (res instanceof Error) {
    console.error(`estimate: history: ${res.message} (priors and the local log only)`);
    return [];
  }
  return (res.items ?? []) as HistoryLike[];
}

/** Close what the history shows done; returns the log including the new closes. */
export function syncLog(log: LogRecord[], history: HistoryLike[], now = Date.now()) {
  const closes = closesFromHistory(foldLog(log).open, history, now);
  appendLog(closes);
  return { log: [...log, ...closes], closed: closes.length };
}

export type RunEstimate = {
  task: string;
  kind?: string;
  tags?: string[];
  lane?: string;
  node?: string;
  guess?: string;
  token?: string;
  noLog?: boolean;
};

/** One estimate, logged (unless noLog). Used by this CLI and progress.ts --eta auto. */
export async function runEstimate(o: RunEstimate): Promise<(Estimate & { id: string }) | Error> {
  if (o.kind !== undefined && !isEstimateKind(o.kind))
    return new Error(`--kind must be one of ${ESTIMATE_KINDS.join(", ")}`);
  let guessMs: number | undefined;
  if (o.guess !== undefined) {
    const g = parseEta(o.guess);
    if (!g || !("in" in g)) return new Error("--guess must be a duration like 40m or 2h");
    guessMs = g.in;
  }
  const now = Date.now();
  const history = await fetchHistory(o.token);
  const { log } = syncLog(readLog(), history, now);
  const lane = o.lane || process.env.LIANKI_LANE || "unknown";
  const e = estimate(
    {
      task: o.task,
      lane,
      ...(o.kind ? { kind: o.kind as LogEstimate["kind"] } : {}),
      ...(o.tags?.length ? { tags: o.tags } : {}),
      ...(guessMs ? { guessMs } : {}),
    },
    samplesFromHistory(history),
    log,
  );
  const id = newEstimateId(now);
  if (!o.noLog)
    appendLog([
      {
        type: "estimate",
        id,
        at: now,
        lane,
        kind: e.kind,
        ...(o.tags?.length ? { tags: o.tags } : {}),
        task: o.task,
        ...(o.node ? { node: o.node } : {}),
        p5: e.p5,
        p50: e.p50,
        p95: e.p95,
        n: e.n,
      },
    ]);
  return { ...e, id };
}

/**
 * A progress report's argv with `--eta auto[:<kind>]` swapped for the
 * estimator's P5-P95 (logged against the node, so `sync` closes it). Shared by
 * progress.ts and `lianki-dev progress`. Unchanged when the --eta is not auto;
 * an Error for a bad report or kind. `note` is the line to print on stderr.
 */
export async function resolveAutoEta(
  argv: string[],
  token?: (flag?: string) => string | undefined,
): Promise<{ argv: string[]; note?: string } | Error> {
  const auto = findAutoEta(argv);
  if (!auto) return { argv };
  const probe = parseProgressArgs(replaceAutoEta(argv, auto, "1m"));
  if (probe instanceof Error) return probe;
  if (probe.cmd !== "report") return new Error("--eta auto is for reports");
  const t = token ? token(probe.token) : probe.token;
  const e = await runEstimate({
    task: probe.report.task,
    node: probe.report.id,
    lane: probe.report.assignee.name,
    ...(auto.kind ? { kind: auto.kind } : {}),
    ...(t ? { token: t } : {}),
  });
  if (e instanceof Error) return new Error(`--eta auto: ${e.message}`);
  return {
    argv: replaceAutoEta(argv, auto, etaRange(e)),
    note: `--eta auto → ${etaRange(e)} (estimate ${e.id}: ${e.kind}, P50 ${formatDuration(e.p50)}, ${e.n} similar)`,
  };
}

export function formatEstimate(e: Estimate & { id: string }): string {
  const f = formatDuration;
  const lines = [
    `${e.id}  ${e.kind}  P5 ${f(e.p5)}  P50 ${f(e.p50)}  P95 ${f(e.p95)}   --eta ${etaRange(e)}`,
    `basis: ${e.n} similar done tasks (weight ${e.effN}), prior ${Math.round(e.priorWeight * 100)}%, ` +
      `lane bias ×${e.bias.factor.toFixed(2)} (n=${e.bias.n}), ` +
      `log ×${e.calibration.factor.toFixed(2)} width ×${e.calibration.width.toFixed(2)} (n=${e.calibration.n})`,
  ];
  for (const s of e.similar) lines.push(`  ${f(s.actualMs).padStart(6)}  ${s.title}`);
  lines.push(
    `close it when done: bun scripts/dev/estimate.ts close ${e.id} (or sync, with --node)`,
  );
  return lines.join("\n");
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      tags: { type: "string" },
      lane: { type: "string" },
      agent: { type: "string" },
      node: { type: "string" },
      guess: { type: "string" },
      actual: { type: "string" },
      token: { type: "string" },
      json: { type: "boolean" },
      "eta-only": { type: "boolean" },
      "no-log": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(ESTIMATE_USAGE);
    return values.help ? 0 : 2;
  }
  const lane = values.lane ?? values.agent;
  const [sub, ...rest] = positionals;
  if (sub === "close") {
    const id = rest[0];
    const e = foldLog(readLog()).open.find((x) => x.id === id);
    if (!e) {
      console.error(`estimate: no open estimate ${id ?? "(none given)"}`);
      return 2;
    }
    let actualMs = Date.now() - e.at;
    if (values.actual !== undefined) {
      const a = parseEta(values.actual);
      if (!a || !("in" in a)) {
        console.error("estimate: --actual must be a duration like 40m");
        return 2;
      }
      actualMs = a.in;
    }
    const rec: LogClose = { type: "close", id: e.id, at: Date.now(), actualMs, source: "manual" };
    appendLog([rec]);
    console.log(
      `estimate: ${e.id} closed: ${formatDuration(actualMs)} (P5 ${formatDuration(e.p5)} – P95 ${formatDuration(e.p95)}${actualMs < e.p5 || actualMs > e.p95 ? ", OUTSIDE" : ""})`,
    );
    return 0;
  }
  if (sub === "sync" || sub === "stats") {
    const { log, closed } = syncLog(readLog(), await fetchHistory(values.token));
    if (sub === "sync") {
      console.log(`estimate: closed ${closed} from the done history`);
      return 0;
    }
    const rows = calibrationStats(log, lane);
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log("kind                closed  open  coverage(P5–P95)  median actual/P50");
      for (const r of rows)
        console.log(
          `${r.kind.padEnd(20)}${String(r.closed).padStart(6)}${String(r.open).padStart(6)}  ${(r.coverage === undefined ? "–" : `${Math.round(r.coverage * 100)}%`).padStart(16)}  ${(r.medianRatio === undefined ? "–" : `×${r.medianRatio.toFixed(2)}`).padStart(17)}`,
        );
      console.log("target coverage is 90%; below it the bands widen, above it they narrow.");
    }
    return 0;
  }
  const e = await runEstimate({
    task: positionals.join(" "),
    ...(values.kind ? { kind: values.kind } : {}),
    ...(values.tags
      ? {
          tags: values.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }
      : {}),
    ...(lane ? { lane } : {}),
    ...(values.node ? { node: values.node } : {}),
    ...(values.guess ? { guess: values.guess } : {}),
    ...(values.token ? { token: values.token } : {}),
    ...(values["no-log"] ? { noLog: true } : {}),
  });
  if (e instanceof Error) {
    console.error(`estimate: ${e.message}`);
    return 2;
  }
  if (values["eta-only"]) console.log(etaRange(e));
  else if (values.json) console.log(JSON.stringify(e, null, 2));
  else console.log(formatEstimate(e));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
