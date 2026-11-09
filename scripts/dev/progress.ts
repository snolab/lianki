#!/usr/bin/env bun
/**
 * Report to the live state tree (docs/state-tree.md, "Live progress"). One
 * request to lianki-push, then exit.
 *
 *   bun scripts/dev/progress.ts --agent swipe-agent --path /words/swipe --task "Native swipe: drag the card with the finger" --status doing --pct 40
 *   bun scripts/dev/progress.ts --agent swipe-agent --path /words/swipe --task "Native swipe: drag the card with the finger" --done --pr 310
 *   bun scripts/dev/progress.ts --agent swipe-agent --path /words/swipe --task "…" --status doing --eta 12m-63m
 *   bun scripts/dev/progress.ts --agent swipe-agent --path /words/swipe --task "…" --status doing --confirm
 *   bun scripts/dev/progress.ts batch '[{"agent":"a","path":"/x/a","task":"A: …","eta":"20m"}, …]'
 *   bun scripts/dev/progress.ts grant --node /words --agent swipe-agent --ttl 8h
 *   bun scripts/dev/progress.ts resolve --id /@owner/agent-yes-527 --note "merged"
 *   bun scripts/dev/progress.ts show [--all]
 *   bun scripts/dev/progress.ts history --since 30d
 *   bun scripts/dev/progress.ts stats --agent swipe-agent --since 7d
 *
 * `--eta 25m` (or an ISO time) is the agent's own estimate; it sets the node's
 * etaAt, which drives the owner's ETA bar and the one "ETA reached" line the
 * agents get when it passes (docs/state-tree.md, "ETA pings"). Past it, a new
 * --eta needs --late "<reason>": the hub tells the owner both ("ETA overrun").
 *
 * The site is LIANKI_URL (default: the production site, as for eval.ts). The
 * token is --token, else LIANKI_PROGRESS_TOKEN, else PROGRESS_TOKEN, else
 * PROGRESS_TOKEN from .dev.vars in this checkout or the main one.
 */
import { BASE } from "./eval-socket";
import { PROGRESS_USAGE, formatHistory, formatStats, parseProgressArgs } from "./progress-args";
import { type ProgressDone, type ProgressHistory, progressStats } from "../../lib/progress";
import { postProgress, progressToken } from "./progress-client";

/** "2026-11-07 20:30 JST": when the estimate runs out, as the owner reads times. */
const etaJst = (at: number) =>
  `${new Date(at + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} JST`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(PROGRESS_USAGE);
  process.exit(0);
}
const cmd = parseProgressArgs(args);
if (cmd instanceof Error) {
  console.error(`progress: ${cmd.message}\n${PROGRESS_USAGE}`);
  process.exit(2);
}
if (cmd.cmd === "report" && cmd.warning) console.error(`progress: warning: ${cmd.warning}`);
if (cmd.cmd === "batch") for (const w of cmd.warnings) console.error(`progress: warning: ${w}`);
const token = progressToken(cmd.token);
if (!token) {
  console.error(
    "progress: no token (--token, LIANKI_PROGRESS_TOKEN, or PROGRESS_TOKEN in .dev.vars)",
  );
  process.exit(2);
}
const [path, body] =
  cmd.cmd === "report"
    ? ["", cmd.report]
    : cmd.cmd === "batch"
      ? ["/batch", { reports: cmd.reports, ...(cmd.changeId ? { changeId: cmd.changeId } : {}) }]
      : cmd.cmd === "grant"
        ? ["/grant", { node: cmd.node, agent: cmd.agent, ttl: cmd.ttl }]
        : cmd.cmd === "resolve"
          ? ["/resolve", { id: cmd.id, note: cmd.note }]
          : cmd.cmd === "stats"
            ? ["/stats", undefined]
            : cmd.cmd === "history"
              ? [`/history?limit=${cmd.limit ?? 2000}`, undefined]
              : ["", undefined];
const res = await postProgress(BASE, token, path, body);
if (res instanceof Error) {
  console.error(`progress: ${res.message}`);
  process.exit(1);
}
if (cmd.cmd === "grant") console.log(res.token);
else if (cmd.cmd === "show") {
  const all = cmd.all ? await postProgress(BASE, token, "/history?limit=2000") : null;
  if (all instanceof Error) console.error(`progress: history: ${all.message}`);
  console.log(
    JSON.stringify(all && !(all instanceof Error) ? { ...res, history: all.items } : res, null, 2),
  );
} else if (cmd.cmd === "history") {
  const items = (res.items ?? []) as ProgressHistory[];
  if (cmd.json) console.log(JSON.stringify(items, null, 2));
  else console.log(formatHistory(items, { agent: cmd.agent, since: cmd.since }));
} else if (cmd.cmd === "stats") {
  const since = Date.now() - cmd.since;
  const done = (res.done ?? []) as ProgressDone[];
  console.log(formatStats(progressStats(done, { agent: cmd.agent, since })));
} else if (cmd.cmd === "batch") {
  const results = (res.results ?? []) as Record<string, unknown>[];
  for (const r of results) {
    const e = r.entry as { id: string; status: string; etaAt?: number } | undefined;
    if (e) console.log(`progress: ${e.id} ${e.status}${e.etaAt ? `, ETA ${etaJst(e.etaAt)}` : ""}`);
    else console.error(`progress: ${r.status} ${String(r.error ?? "failed")}`);
  }
  console.log(`progress: change ${String(res.changeId)} (${results.length} nodes)`);
  if (res.ok === false) process.exit(1);
} else if (cmd.cmd === "resolve")
  console.log(
    `progress: resolved ${(res.resolved as string[]).join(", ") || "nothing (already done)"}`,
  );
else {
  const e = res.entry as {
    id: string;
    status: string;
    rev: number;
    etaAt?: number;
    etaMinAt?: number;
  };
  const eta = e.etaAt
    ? `, ETA ${e.etaMinAt ? `${etaJst(e.etaMinAt).slice(11, 16)}–` : ""}${etaJst(e.etaAt)}`
    : "";
  console.log(`progress: ${e.id} ${e.status} (rev ${e.rev}${eta}, ${res.readers ?? 0} watching)`);
  if (res.told === true) console.log("progress: the owner was told the reason and the new time");
  else if (res.told === false)
    console.error("progress: warning: the reason could not be posted to the owner; say it in Li");
}
