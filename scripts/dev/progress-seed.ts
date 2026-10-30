#!/usr/bin/env bun
/**
 * Seed the live state tree with the owner's open to-dos (docs/state-tree.md,
 * "Live progress"): each is a decision or approval node in the tree plus an
 * `/@owner/<slug>` to-do that refs it. Idempotent by id: a node that already
 * exists (open or resolved) is left alone, so running it twice never reopens
 * anything. Needs the root token (as scripts/dev/progress.ts finds it).
 *
 *   bun scripts/dev/progress-seed.ts [--token <token>] [--dry-run]
 */
import type { ProgressKind } from "../../lib/progress";
import { BASE } from "./eval-socket";
import { postProgress, progressToken } from "./progress-client";

const AGENT = "main-lane";
type Seed = {
  id: string;
  kind: ProgressKind;
  task: string;
  needs: string;
  action?: string;
  link?: string;
  pr?: number;
};

const SEEDS: Seed[] = [
  {
    id: "/_liagent/agent-yes-527",
    kind: "approval",
    task: "Merge agent-yes #527",
    needs: "merge agent-yes #527 (liagent via agent-yes/liagent)",
    action: "! gh pr merge 527 -R snomiao/agent-yes --squash",
    link: "https://github.com/snomiao/agent-yes/pull/527",
  },
  {
    id: "/_infra/status-bar-ab",
    kind: "decision",
    task: "Status-bar colour A/B",
    needs: "pick the status-bar colour A/B (#279)",
    link: "https://github.com/snolab/lianki/pull/279",
    pr: 279,
  },
  {
    id: "/_infra/name-initials",
    kind: "decision",
    task: "'LP' initials for Learning Partner",
    needs: "OK the 'LP' initials check for Learning Partner",
  },
  {
    id: "/_infra/stt-mixed-lang",
    kind: "approval",
    task: "Mixed-language STT on iPhone",
    needs: "test mixed-language STT on iPhone (speak zh+en in one sentence)",
  },
  {
    id: "/_liagent/npm-publish",
    kind: "approval",
    task: "npm publishing for liagent",
    needs: "npm login / trusted publishing for liagent (later)",
  },
  {
    id: "/_infra/progress-token",
    kind: "approval",
    task: "PROGRESS_TOKEN Worker secret",
    needs: "set the PROGRESS_TOKEN Worker secret",
    action: "bunx wrangler secret put PROGRESS_TOKEN -c workers/push/wrangler.jsonc",
  },
  {
    id: "/_liagent/tag-ruleset",
    kind: "approval",
    task: "v* tag ruleset on snolab/liagent",
    needs: "add a v* tag ruleset on snolab/liagent (block update/delete)",
  },
  {
    id: "/_liagent/liagent-pr-1",
    kind: "approval",
    task: "Review snolab/liagent#1 (avatars)",
    needs: "review snolab/liagent#1 (avatars)",
    link: "https://github.com/snolab/liagent/pull/1",
  },
  {
    id: "/dev/roadmap/refresh",
    kind: "approval",
    task: "Roadmap refresh PR",
    needs: "review the roadmap refresh PR diff",
  },
];

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const flag = args.indexOf("--token");
const token = progressToken(flag >= 0 ? args[flag + 1] : undefined);
if (!token && !dry) {
  console.error(
    "progress-seed: no token (--token, LIANKI_PROGRESS_TOKEN, or PROGRESS_TOKEN in .dev.vars)",
  );
  process.exit(2);
}

const have = new Set<string>();
if (!dry) {
  const state = await postProgress(BASE, token!, "");
  if (state instanceof Error) {
    console.error(`progress-seed: ${state.message}`);
    process.exit(1);
  }
  for (const e of state.entries as { id: string }[]) have.add(e.id);
}

let failed = 0;
for (const s of SEEDS) {
  const slug = s.id.slice(s.id.lastIndexOf("/") + 1);
  const { needs, action, link, ...task } = s;
  const extras = { ...(action ? { action } : {}), ...(link ? { link } : {}) };
  const reports = [
    { ...task, ...(link ? { link } : {}), agent: AGENT, status: "waiting-owner" },
    {
      id: `/@owner/${slug}`,
      kind: s.kind,
      task: needs,
      needs,
      ref: s.id,
      agent: AGENT,
      status: "waiting-owner",
      ...extras,
    },
  ];
  for (const r of reports) {
    if (have.has(r.id)) {
      console.log(`skip  ${r.id} (exists)`);
      continue;
    }
    if (dry) {
      console.log(`would ${JSON.stringify(r)}`);
      continue;
    }
    const res = await postProgress(BASE, token!, "", r);
    if (res instanceof Error) {
      failed++;
      console.error(`fail  ${r.id}: ${res.message}`);
    } else console.log(`seed  ${r.id}`);
  }
}
process.exit(failed ? 1 : 0);
