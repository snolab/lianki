/**
 * The lanes manager's config (scripts/dev/lanes-manager.ts; docs/lane-listen.md,
 * "Every agent joins"): the defaults the registry (lib/config.ts `lanes.*`)
 * holds, and how the Mac reads its live values. The manager runs on the Mac,
 * not in the Worker, so each key's live value there is its env var (like
 * stall-watch's, scripts/dev/stall-watch-lib.ts); a value that does not check
 * out is the default. Client-safe: no fs, no process.
 */
import { z } from "zod";

/** A registered agent: which agents get a fixed lane name (and whether they listen live). */
export type LaneAgentDef = {
  /** The end of the agent's working directory ("lianki/tree/codex"); matched on whole path parts. */
  cwd: string;
  /** Its agent CLI (`ay ls` cli: codex, claude, agy…); absent = any. */
  cli?: string;
  /** Its lane: the token's name. */
  lane: string;
  /** A resident listener: hears every line live (lane-listen --all). Else a reader, woken by name. */
  resident?: boolean;
};

export const LANE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,39}$/u;

export const laneAgentSchema = z
  .object({
    cwd: z.string().min(1).max(200),
    cli: z
      .string()
      .regex(/^[a-z0-9_-]{1,24}$/)
      .optional(),
    lane: z.string().regex(LANE_NAME_RE, "a lane name: the token's name"),
    resident: z.boolean().optional(),
  })
  .strict();

export const LANES_CONFIG_DEFAULTS = {
  /** Lianki and the repos it depends on (owner, 2026-11-15: agent-yes, liagent, rechrome, otoji, rgui, …). */
  "lanes.repos": ["lianki", "agent-yes", "liagent", "rechrome", "otoji", "rgui"],
  /** coco and 杰咪 keep listening to everything (owner, 2026-11-15). */
  "lanes.agents": [
    { cwd: "lianki/tree/codex", cli: "codex", lane: "codex", resident: true },
    { cwd: "lianki/tree/agy", cli: "agy", lane: "agy", resident: true },
  ] as LaneAgentDef[],
  "lanes.relistSec": 60,
  "lanes.greeting": "大家好，我是 {name}（{repo} · {cli}），{mode}入群。",
} as const;

/** The env var each Mac-side key is read from. */
export const LANES_ENV = {
  "lanes.repos": "LIANKI_LANES_REPOS",
  "lanes.agents": "LIANKI_LANES_AGENTS",
  "lanes.relistSec": "LIANKI_LANES_RELIST_SEC",
  "lanes.greeting": "LIANKI_LANES_GREETING",
} as const;

export type LanesConfig = {
  repos: string[];
  agents: LaneAgentDef[];
  relistSec: number;
  greeting: string;
};

/** The manager's config: each key's env value when it checks out, else its default. */
export function lanesConfig(env: Record<string, string | undefined> = {}): LanesConfig {
  const d = LANES_CONFIG_DEFAULTS;
  const repos = (env[LANES_ENV["lanes.repos"]] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z0-9._-]{1,40}$/.test(x));
  let agents: LaneAgentDef[] = [...d["lanes.agents"]];
  const rawAgents = env[LANES_ENV["lanes.agents"]];
  if (rawAgents)
    try {
      const v = z.array(laneAgentSchema).max(64).safeParse(JSON.parse(rawAgents));
      if (v.success) agents = v.data;
    } catch {}
  const n = Number(env[LANES_ENV["lanes.relistSec"]]);
  const relistSec = Number.isInteger(n) && n >= 10 && n <= 3600 ? n : d["lanes.relistSec"];
  const g = env[LANES_ENV["lanes.greeting"]]?.trim();
  return {
    repos: repos.length ? repos : [...d["lanes.repos"]],
    agents,
    relistSec,
    greeting: g && g.length <= 200 ? g : d["lanes.greeting"],
  };
}
