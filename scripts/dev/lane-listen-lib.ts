/**
 * The pure half of ./lane-listen.ts (docs/lane-listen.md): where a lane's
 * token comes from (never printed), reading both listeners' JSON lines, and
 * what the lane's agent is handed. Tested in unit/lane-listen.test.ts.
 */
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RouteLane, routeLine, testText } from "../../lib/lane-route";

/** Where a lane's token is kept on this Mac. */
export const laneTokenDir = (env: Record<string, string | undefined> = process.env) =>
  env.LIANKI_LANE_TOKEN_DIR || join(homedir(), ".config", "lianki", "lanes");
export const laneTokenPath = (lane: string, env?: Record<string, string | undefined>) =>
  join(laneTokenDir(env), `${lane}.token`);

/**
 * The lane's token: LIANKI_TOKEN, else its file. The file must be the owner's
 * alone (no group or other bits) and hold one lk_ token. Never logged.
 */
export function laneToken(
  lane: string | undefined,
  env: Record<string, string | undefined> = process.env,
): { token: string; from: "env" | "file" } | { token?: undefined; from: "none"; why: string } {
  const e = env.LIANKI_TOKEN?.trim();
  if (e) return { token: e, from: "env" };
  if (!lane || !/^[A-Za-z0-9._-]{1,40}$/.test(lane) || lane.includes(".."))
    return { from: "none", why: "no lane (--as) to look a token up for" };
  const path = laneTokenPath(lane, env);
  // One open file: its mode and its contents are the same file's.
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { from: "none", why: `no token file ${path}` };
  }
  let t: string;
  try {
    if (fstatSync(fd).mode & 0o077)
      return { from: "none", why: `${path} is readable by others: chmod 600 it` };
    t = readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
  if (!/^lk_[A-Za-z0-9_-]{16,}$/.test(t))
    return { from: "none", why: `${path} does not hold an lk_ token` };
  return { token: t, from: "file" };
}

/** What the owner makes at lianki.com/my/preferences → API tokens for `lane`. */
export const tokenNeeded = (lane: string, env?: Record<string, string | undefined>) =>
  `a lane token for ${lane}: lianki.com/my/preferences → API tokens → name "${lane}", permissions chat:read chat:write chat:ask (nothing else), an expiry; saved at ${laneTokenPath(lane, env)} (chmod 600) or passed as LIANKI_TOKEN`;

/** A chat line from either listener's JSON (eval.ts chat, or `lianki chat listen --json`). */
export type Line = {
  id: string;
  thread: string;
  from: string;
  text: string;
  at?: string;
  /** An automatic state-tree line (source "eta") addressed to this lane: a blocked nudge, or "main". */
  etaLane?: string;
  /** The Mac's voiceprint decision on a spoken owner line: "me" | "other" | "unknown" (absent: typed, or no print). */
  voice?: string;
};
/**
 * Whether a lane may hear this owner line (owner, 2026-11-14 23:2x: "只有我自己的
 *语音才广播给所有 agent"): a line the voiceprint decided was someone else never
 * goes out; an "unknown" one (his own short or soft sentence) does, marked, unless
 * LANE_LISTEN_VOICES=me asks for his decided voice only. The chat lane still
 * sees every line (it polishes and answers in the thread).
 */
export function voiceAllowed(l: Pick<Line, "from" | "voice">, env = process.env): boolean {
  if (l.from !== "owner" || !l.voice) return true;
  if (l.voice === "other") return false;
  if (l.voice === "unknown") return env.LANE_LISTEN_VOICES !== "me";
  return true;
}
export function lineOf(raw: string): (Line & { history: boolean }) | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || v.type !== "chat") return null;
  const m = (v.message && typeof v.message === "object" ? v.message : v) as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.text !== "string") return null;
  return {
    id: m.id,
    thread: typeof m.thread === "string" ? m.thread : "owner",
    from: typeof m.from === "string" ? m.from : "",
    text: m.text,
    ...(m.source === "eta" &&
    m.from === "agent" &&
    m.eta &&
    typeof (m.eta as { lane?: unknown }).lane === "string"
      ? { etaLane: (m.eta as { lane: string }).lane }
      : {}),
    ...(m.at !== undefined
      ? { at: String(typeof m.at === "number" ? new Date(m.at).toISOString() : m.at) }
      : {}),
    ...(m.speaker &&
    typeof m.speaker === "object" &&
    typeof (m.speaker as { decision?: unknown }).decision === "string"
      ? { voice: (m.speaker as { decision: string }).decision }
      : {}),
    history: v.history === true,
  };
}

/** HH:MM in JST. */
export const jst = (at?: string) => {
  const d = at ? new Date(at) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return new Date(t.getTime() + 9 * 3600_000).toISOString().slice(11, 16);
};

/** What the lane's agent is handed: his words, and how to answer as itself. */
export function handoff(lane: RouteLane, l: Line, repo: string): string {
  if (l.etaLane === lane)
    return [
      `【state tree → ${lane}】(${jst(l.at)} JST, automatic) ${l.text}`,
      "",
      'The state tree\'s hub sent this to your lane (docs/state-tree.md, "Blocked and paused", "Receipts"). Act on it; report on the node with bun scripts/dev/progress.ts, or answer in Li with:',
      `  bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} say --repo ${repo} --as ${lane} "<your reply>"`,
    ].join("\n");
  const test = testText(l);
  const words = test ?? l.text;
  const said = routeLine(words);
  const reply = `bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} say --repo ${repo} --as ${lane} "<your reply>"`;
  return [
    test === null
      ? `【owner → ${lane}】(${jst(l.at)} JST, Li chat) ${words}`
      : `【lane-test → ${lane}】(${jst(l.at)} JST) ${words}`,
    "",
    test !== null
      ? 'This is a routing TEST, not the owner. Answer once, starting "[lane-test] ", one short line, so the test sees you heard it:'
      : said.lanes.includes(lane)
        ? `He addressed this to you by name; only you got it, the other lanes stay silent. Answer once, yourself, short, in his language${said.text ? "" : " (he only said your name: ask what he needs)"}:`
        : "Heard, not addressed to you by name (you listen to all his lines): keep it as context. Answer only if it is clearly meant for you; otherwise stay silent, another lane answers. To answer:",
    `  ${reply}`,
    "It posts as your lane (your name, mark and voice) with your own lane token; never read or print the token. Do not hand this to another lane.",
  ].join("\n");
}

/** The skill every lane's agent reads once; after that the hand-offs stay short. */
export const HANDOFF_SKILL = ".agents/skills/lane-listen/SKILL.md";

/**
 * One owner line as a bullet of a brief hand-off: the id to answer with, "@你"
 * when he said this lane's name (lane-route.ts), then his words (owner,
 * 2026-11-14: every short line used to arrive as its own long message with the
 * whole instruction block; the instructions now live in HANDOFF_SKILL).
 */
export function briefBullet(lane: RouteLane, l: Line): string {
  if (l.etaLane === lane) return `- (state tree) ${l.text}`;
  const test = testText(l);
  if (test !== null) return `- (id:${l.id}) [lane-test] ${test}`;
  const mine = routeLine(l.text).lanes.includes(lane);
  const unsure = l.voice === "unknown" ? "（声纹未定）" : "";
  return `- (id:${l.id})${mine ? " @你" : ""}${unsure} ${l.text}`;
}

/**
 * A brief hand-off for one or more lines (several when the agent was busy and
 * they waited): a header with the lane and the newest line's time, one bullet
 * per line, and — only the first time in this listener's life — where the
 * rules are. ~2 lines per message instead of ~8.
 */
export function handoffBrief(
  lane: RouteLane,
  lines: readonly Line[],
  repo: string,
  first: boolean,
): string {
  const at = jst(lines.at(-1)?.at);
  const out = [`【owner → ${lane}】${at} JST`, ...lines.map((l) => briefBullet(lane, l))];
  if (first)
    out.push(
      `规则只读这一次：${join(repo, HANDOFF_SKILL)}（回复：bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} reply --as ${lane} --id <id> "…"）`,
    );
  return out.join("\n");
}

/** How often a busy agent is looked at while lines wait for it. */
export const BUSY_RECHECK_MS = 5_000;

/**
 * Lines wait here while the agent is busy; when it is free they go as ONE
 * message (handoffBrief), in order. The first message of the listener's life
 * also names the skill with the rules.
 */
/**
 * A line that must reach the lane now, even mid-turn: he said this lane's name
 * or "全体" (lane-route.ts), or a state-tree nudge is addressed to it (owner,
 * 2026-11-14 22:5x: "coco和杰米好像干活的时候都不理我"). Everything else waits
 * for the batch.
 */
export const urgentLine = (lane: RouteLane, l: Line) => {
  if (l.etaLane === lane) return true;
  const r = routeLine(l.text);
  return r.addressed && r.lanes.includes(lane);
};
export function makeDeliverer(
  o: { lane: RouteLane; repo: string },
  send: (body: string, interrupt: boolean) => Promise<number>,
  busy: () => Promise<boolean>,
  log: (v: Record<string, unknown>) => void = () => {},
  recheckMs = BUSY_RECHECK_MS,
) {
  const pending: Line[] = [];
  let first = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async (interrupt = false): Promise<number | undefined> => {
    if (!pending.length) return undefined;
    if (!interrupt && (await busy())) {
      if (process.env.LANE_LISTEN_DEBUG)
        log({ type: "held", lane: o.lane, pending: pending.length });
      timer ??= setTimeout(() => {
        timer = undefined;
        void flush();
      }, recheckMs);
      return undefined;
    }
    const batch = pending.splice(0, pending.length);
    const code = await send(handoffBrief(o.lane, batch, o.repo, first), interrupt);
    first = false;
    log({ type: "delivered", lane: o.lane, ids: batch.map((l) => l.id), interrupt, ay: code });
    return code;
  };
  return {
    add: async (l: Line) => {
      pending.push(l);
      return flush(urgentLine(o.lane, l));
    },
    pending: () => pending.length,
  };
}
