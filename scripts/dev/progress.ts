#!/usr/bin/env bun
/**
 * Report to the live state tree (docs/state-tree.md, "Live progress"). One
 * request to lianki-push, then exit.
 *
 *   bun scripts/dev/progress.ts --agent swipe-agent --path /words/swipe --task "Native swipe" --status doing --pct 40
 *   bun scripts/dev/progress.ts --agent swipe-agent --path /words/swipe --task "Native swipe" --done --pr 310
 *   bun scripts/dev/progress.ts grant --node /words --agent swipe-agent --ttl 8h
 *   bun scripts/dev/progress.ts resolve --id /@owner/agent-yes-527 --note "merged"
 *   bun scripts/dev/progress.ts show
 *
 * The site is LIANKI_URL (default: the production site, as for eval.ts). The
 * token is --token, else LIANKI_PROGRESS_TOKEN, else PROGRESS_TOKEN, else
 * PROGRESS_TOKEN from .dev.vars in this checkout or the main one.
 */
import { BASE } from "./eval-socket";
import { PROGRESS_USAGE, parseProgressArgs } from "./progress-args";
import { postProgress, progressToken } from "./progress-client";

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
    : cmd.cmd === "grant"
      ? ["/grant", { node: cmd.node, agent: cmd.agent, ttl: cmd.ttl }]
      : cmd.cmd === "resolve"
        ? ["/resolve", { id: cmd.id, note: cmd.note }]
        : ["", undefined];
const res = await postProgress(BASE, token, path, body);
if (res instanceof Error) {
  console.error(`progress: ${res.message}`);
  process.exit(1);
}
if (cmd.cmd === "grant") console.log(res.token);
else if (cmd.cmd === "show") console.log(JSON.stringify(res, null, 2));
else if (cmd.cmd === "resolve")
  console.log(
    `progress: resolved ${(res.resolved as string[]).join(", ") || "nothing (already done)"}`,
  );
else {
  const e = res.entry as { id: string; status: string; rev: number };
  console.log(`progress: ${e.id} ${e.status} (rev ${e.rev}, ${res.readers ?? 0} watching)`);
}
