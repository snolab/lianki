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
  /** Woken by name (`ay send`) when a line names it; false = it joins (greets, reader) but is never woken. Default true. */
  wake?: boolean;
  /**
   * What a live lane hears (docs/lane-listen.md, "Six tiers"): "owner" (default) his lines
   * only (tier ②); "all" his lines and every agent's, no system lines (tier ①, lane-listen
   * --everyone); "system" all of that and the system notices too (tier ⓪, --system).
   * "all" and "system" make the lane live (a listener) even without `resident`.
   */
  scope?: LaneScope;
  /**
   * It may answer the owner's lines that name nobody when it has something to
   * say, briefly (owner, 2026-11-15 22:55 JST: "@coco 和杰咪都应该回复我，哪怕是没点名的信息");
   * named lines are always answered, lines naming another lane never. Absent = it
   * listens to unnamed lines silently (only 点名 or 全体).
   */
  answerUnnamed?: boolean;
};

/** What a live lane hears: the owner's lines only, every line in the thread, or every line and the system notices. */
export type LaneScope = "owner" | "all" | "system";
export const LANE_SCOPES = ["owner", "all", "system"] as const;
/** Does this scope hear every line (tier ① or ⓪)? */
export const hearsAll = (s?: LaneScope) => s === "all" || s === "system";

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
    wake: z.boolean().optional(),
    scope: z.enum(LANE_SCOPES).optional(),
    answerUnnamed: z.boolean().optional(),
  })
  .strict();

export const LANES_CONFIG_DEFAULTS = {
  /** Lianki and the repos it depends on (owner, 2026-11-15: agent-yes, liagent, rechrome, otoji, rgui, …). */
  "lanes.repos": ["lianki", "agent-yes", "liagent", "rechrome", "otoji", "rgui", "mimiai"],
  /** coco and 杰咪 keep listening to everything (owner, 2026-11-15). */
  "lanes.agents": [
    // coco hears every line too (owner, 2026-11-15 15:44 JST: tier ①, like 小克).
    {
      cwd: "lianki/tree/codex",
      cli: "codex",
      lane: "codex",
      resident: true,
      scope: "all",
      answerUnnamed: true,
    },
    // coco and 杰咪 may answer his unnamed lines too (owner, 2026-11-15 22:55 JST).
    { cwd: "lianki/tree/agy", cli: "agy", lane: "agy", resident: true, answerUnnamed: true },
    // mimiai's codex listens to everything too (owner, 2026-11-15 13:2x JST "把它叫进来这里监听").
    { cwd: "mimiai/tree/main", cli: "codex", lane: "mimiai", resident: true, answerUnnamed: true },
    // 小克 (the Claude Code chat lane) keeps its own live feed of the owner's
    // lines: it joins as `claude`, but the manager never wakes it. It hears every
    // other line live and the system notices too (owner, 2026-11-16 02:16 JST: tier ⓪,
    // scope "system"): its lane-listen --everyone --system skips his lines, which its
    // own feed already brings.
    {
      cwd: "lianki/tree/agy",
      cli: "claude",
      lane: "claude",
      wake: false,
      scope: "system",
      // 小克 answers from its own feed by its own judgement; the manager's hand-offs stay listen-only.
      answerUnnamed: false,
    },
  ] as LaneAgentDef[],
  "lanes.relistSec": 60,
  /** Tier ② lanes get a line whose voiceprint is undecided ("未定不送", owner 2026-11-15 15:44 JST: no). */
  "lanes.forwardUnknownVoice": false as boolean,
  /** A read-only lane named in his line hears his following lines live this many minutes. */
  "lanes.wakeLiveMin": 5,
  /** An agent whose live output has been quiet this many seconds is shown idle again (the busy ring stops). */
  "lanes.busyIdleSec": 8,
  "lanes.greeting":
    "大家好，我是 {name}（{repo} · {cli}），{mode}入群。只回答点名我或「全体」的话。",
  /** The greeting of a lane that may answer unnamed lines (lanes.agents answerUnnamed). */
  "lanes.greetingAnswerUnnamed":
    "大家好，我是 {name}（{repo} · {cli}），{mode}入群。点名我必答，没点名但和我的项目有关的话也会简短答。",
} as const;

/** The env var each Mac-side key is read from. */
export const LANES_ENV = {
  "lanes.repos": "LIANKI_LANES_REPOS",
  "lanes.agents": "LIANKI_LANES_AGENTS",
  "lanes.relistSec": "LIANKI_LANES_RELIST_SEC",
  "lanes.forwardUnknownVoice": "LIANKI_LANES_FORWARD_UNKNOWN_VOICE",
  "lanes.wakeLiveMin": "LIANKI_LANES_WAKE_LIVE_MIN",
  "lanes.busyIdleSec": "LIANKI_LANES_BUSY_IDLE_SEC",
  "lanes.greeting": "LIANKI_LANES_GREETING",
  "lanes.greetingAnswerUnnamed": "LIANKI_LANES_GREETING_ANSWER_UNNAMED",
} as const;

export type LanesConfig = {
  repos: string[];
  agents: LaneAgentDef[];
  relistSec: number;
  forwardUnknownVoice: boolean;
  wakeLiveMin: number;
  busyIdleSec: number;
  greeting: string;
  greetingAnswerUnnamed: string;
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
  const fwd = env[LANES_ENV["lanes.forwardUnknownVoice"]]?.trim();
  const w = Number(env[LANES_ENV["lanes.wakeLiveMin"]]);
  const b = Number(env[LANES_ENV["lanes.busyIdleSec"]]);
  const g = env[LANES_ENV["lanes.greeting"]]?.trim();
  const ga = env[LANES_ENV["lanes.greetingAnswerUnnamed"]]?.trim();
  return {
    repos: repos.length ? repos : [...d["lanes.repos"]],
    agents,
    relistSec,
    forwardUnknownVoice:
      fwd === "true" || fwd === "1"
        ? true
        : fwd === "false" || fwd === "0"
          ? false
          : d["lanes.forwardUnknownVoice"],
    wakeLiveMin:
      Number.isInteger(w) && w >= 0 && w <= 240 && env[LANES_ENV["lanes.wakeLiveMin"]]?.trim()
        ? w
        : d["lanes.wakeLiveMin"],
    busyIdleSec: Number.isInteger(b) && b >= 1 && b <= 600 ? b : d["lanes.busyIdleSec"],
    greeting: g && g.length <= 200 ? g : d["lanes.greeting"],
    greetingAnswerUnnamed: ga && ga.length <= 200 ? ga : d["lanes.greetingAnswerUnnamed"],
  };
}
