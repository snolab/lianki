/**
 * The pure half of ./lane-listen.ts (docs/lane-listen.md): where a lane's
 * token comes from (never printed), reading both listeners' JSON lines, and
 * what the lane's agent is handed. Tested in unit/lane-listen.test.ts.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type RouteLane,
  laneOfRoute,
  laneTakes,
  routeLine,
  routeOfLane,
  testText,
} from "../../lib/lane-route";
import { isLaneId, laneOf, laneSpec } from "../../packages/debug-chat/src/voices";
import { lanesConfig } from "../../lib/lanes-config";
import { SPEND_ALERT_LABEL } from "../../lib/payments/spend-alert-config";
import { ownerClock, ownerTag } from "./owner-time";

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
  /**
   * An agent's line ("agent", for a lane that hears every line: lane-listen --everyone,
   * tier ①) or a system line ("system": the hub's lane events, the lanes manager's, a
   * state-tree line for another lane; only for tier ⓪, --system). Absent: the owner's
   * (or a friend's) line.
   */
  kind?: "agent" | "system";
  /** An agent line's sender: its shown name ("coco", "Li") and its lane (token name or lane id). */
  sender?: string;
  senderLane?: string;
  /** A lane event's lane (a system line about that lane). */
  eventLane?: string;
  /** The hub's sequence number for the line in its thread (absent on an old hub). */
  seq?: number;
};
/**
 * Whether a lane may hear this owner line (owner, 2026-11-14 23:2x: "只有我自己的
 * 语音才广播给所有 agent"): a line the voiceprint decided was someone else never
 * goes out. An "unknown" one (his own short or soft sentence, or not) goes, marked,
 * to a lane that hears every line (tier ①, `everyone`) unless LANE_LISTEN_VOICES=me;
 * to a lane on his lines only (tier ②) not at all ("未定不送", owner 2026-11-15
 * 15:44 JST) unless config lanes.forwardUnknownVoice says so. The chat lane still
 * sees every line (it polishes and answers in the thread).
 */
export function voiceAllowed(
  l: Pick<Line, "from" | "voice">,
  o: { everyone?: boolean } = {},
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (l.from !== "owner" || !l.voice) return true;
  if (l.voice === "other") return false;
  if (l.voice === "unknown")
    return o.everyone ? env.LANE_LISTEN_VOICES !== "me" : lanesConfig(env).forwardUnknownVoice;
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
    ...(m.from === "agent" ? agentFields(m) : {}),
    ...(validSeq(m.seq) ? { seq: m.seq } : {}),
    history: v.history === true,
  };
}

/**
 * The labels of lines the system posts (lane-registry.ts LANE_EVENT_LABEL, the lanes
 * manager's token; the hub's spend alerts, debug.ts spendApi).
 */
const SYSTEM_LABELS = new Set(["lanes", SPEND_ALERT_LABEL]);

/** An agent line's kind, sender and (its prefix gone) text; a system line's kind and event lane. */
function agentFields(m: Record<string, unknown>): Partial<Line> {
  // A routing test line (--tests) stays what it was: not an agent's FYI.
  if (testText({ from: "agent", text: m.text as string }) !== null) return {};
  const ev = m.laneEvent as { lane?: unknown } | undefined;
  const label = typeof m.label === "string" ? m.label : "";
  if (
    (ev && typeof ev === "object") ||
    SYSTEM_LABELS.has(label) ||
    m.source === "eta" ||
    m.agentId === "eta"
  )
    return {
      kind: "system",
      ...(ev && typeof ev.lane === "string" ? { eventLane: ev.lane } : {}),
    };
  const r = laneOf({ lane: m.lane, text: m.text as string });
  const tokenLane = typeof m.tokenLane === "string" ? m.tokenLane : undefined;
  const senderLane = tokenLane ?? r.lane ?? (label || undefined);
  const known = r.lane ?? (tokenLane && isLaneId(tokenLane) ? tokenLane : null);
  const sender = (known && laneSpec(known).name) || (known === "main" ? "Li" : "") || senderLane;
  return {
    kind: "agent",
    text: r.text,
    ...(sender ? { sender } : {}),
    ...(senderLane ? { senderLane } : {}),
  };
}

/** What a listener was started with (lane-listen.ts flags). */
export type TakeOpts = {
  lane: string;
  tests?: boolean;
  all?: boolean;
  /** --everyone: agents' lines too (tier ①). */
  everyone?: boolean;
  /** --system: the system lines as well (tier ⓪; with --everyone). */
  system?: boolean;
  /** --skip-owner: none of his lines (the lane has its own feed of them). */
  skipOwner?: boolean;
};

/**
 * Does this listener take the line: a state-tree nudge to it, his lines it hears, with
 * --everyone agents' lines, and with --system the system lines (owner, 2026-11-16 02:16
 * JST: only the top tier hears the system notices).
 */
export function listenerTakes(o: TakeOpts, l: Line): boolean {
  if (l.etaLane === o.lane) return true;
  if (l.kind === "system" && !o.system) return false;
  if (o.everyone && everyoneTakes(o.lane, l)) return true;
  if (o.skipOwner && l.from === "owner") return false;
  return laneTakes(routeKey(o.lane), l, { tests: o.tests, all: o.all });
}

/** The route lane a listening lane matches as: 小克's token "claude" answers as the route "chat". */
export const routeKey = (lane: string): RouteLane =>
  isLaneId(lane) ? (routeOfLane(lane) ?? lane) : lane;
/** The chat lane id a listening lane is ("chat" and "claude" are 小克's). */
const laneIdKey = (lane: string) => laneOfRoute(routeKey(lane));

/** Is this line the lane's own (its own say, or a system line about itself)? Never handed back to it. */
export function ownLine(lane: string, l: Pick<Line, "kind" | "senderLane" | "eventLane">): boolean {
  if (l.kind === "system")
    return l.eventLane !== undefined && laneIdKey(l.eventLane) === laneIdKey(lane);
  if (l.kind !== "agent" || !l.senderLane) return false;
  return l.senderLane === lane || laneIdKey(l.senderLane) === laneIdKey(lane);
}

/**
 * Does a lane that hears every line (--everyone) take this agent or system line? In the
 * owner thread, not its own (listenerTakes keeps system lines for --system). Owner
 * lines go through laneTakes as before.
 */
export function everyoneTakes(
  lane: string,
  l: Pick<Line, "kind" | "thread" | "senderLane" | "eventLane">,
): boolean {
  if (!l.kind || (l.thread ?? "owner") !== "owner") return false;
  return !ownLine(lane, l);
}

/** "HH:MM TAG" in the machine's zone (or LIANKI_OWNER_TZ), e.g. "01:06 JST"; now for a bad time. */
export const ownerAt = (at?: string) => {
  const d = at ? new Date(at) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${ownerClock(t)} ${ownerTag(t)}`;
};

/**
 * The rule every lane hears (owner, 2026-11-15 15:0x JST: "我在 @ 你的时候，这些只读
 * AI（包括 mimiai）不要乱回复"): answer only a line that names you or 全体.
 */
export const NO_CROSS_RULE = "只答「点名你」「全体」；点名别人的不插话、不代答。";
/**
 * The rule of a lane that may answer unnamed lines (lanes.agents answerUnnamed; owner,
 * 2026-11-15 22:55 JST: "@coco 和杰咪都应该回复我，哪怕是没点名的信息，只要他们觉得他们有回答的想法就可以来回答"):
 * a line naming another lane is still never answered.
 */
export const ANSWER_UNNAMED_RULE =
  "「点名你」「全体」必答；「未点名」与你的项目有关才简短答；点名别人的不插话。";

/** How a lane treats his lines that name nobody: listen only (default), or answer briefly when it has something to say. */
export type UnnamedOpts = { answerUnnamed?: boolean };

/** Whom a line is for, as `lane` sees it: "mine" (its name or 全体), "other" (another lane's name), or "none". */
export function addressee(
  lane: RouteLane,
  text: string,
): { to: "mine"; all: boolean } | { to: "other"; names: string[] } | { to: "none" } {
  const r = routeLine(text);
  if (!r.addressed) return { to: "none" };
  if (r.all) return { to: "mine", all: true };
  if (r.lanes.includes(routeKey(lane))) return { to: "mine", all: false };
  return { to: "other", names: r.lanes.map((x) => laneSpec(laneOfRoute(x)).name || x) };
}

/**
 * The marks in front of a line (owner, 2026-11-15 23:13 JST: "每次从监听器转给 agent 的
 * token 不要消耗太多……回答规则之类的，可以作为 SKILL 加载"): one short token each; what
 * each means and what to do with it is in HANDOFF_SKILL, read once.
 */
export const MINE_MARK = "点名你";
export const ALL_MARK = "全体";
export const NONE_MARK = "未点名";
export const TEST_MARK = "测试";
export const STATE_TREE_MARK = "状态树";
/** After the mark of a spoken line the voiceprint could not decide. */
export const UNSURE_MARK = "（声纹未定）";
/** The mark of a line he addressed to another lane by name. */
export const otherMark = (names: readonly string[]) => `点名${names.join("、")}（不是你）`;
/** How an agent line and a system line are marked in a hand-off. */
export const agentMark = (name?: string) => `【agent · ${name || "?"}】`;
export const SYSTEM_MARK = "【系统】";
/** Once per batch that holds a state-tree line for this lane: where to answer it. */
export const STATE_TREE_NOTE = "状态树：在节点上用 scripts/dev/progress.ts 报告。";

/** The one mark of a line, as `lane` sees it. */
export function lineMark(lane: RouteLane, l: Line): string {
  if (l.etaLane === lane) return STATE_TREE_MARK;
  if (l.kind === "agent") return agentMark(l.sender);
  if (l.kind === "system") return SYSTEM_MARK;
  if (testText(l) !== null) return TEST_MARK;
  const to = addressee(lane, l.text);
  const mark =
    to.to === "mine"
      ? to.all
        ? ALL_MARK
        : MINE_MARK
      : to.to === "other"
        ? otherMark(to.names)
        : NONE_MARK;
  return l.voice === "unknown" ? `${mark}${UNSURE_MARK}` : mark;
}

/** The skill every lane's agent reads once; after that the hand-offs stay short. */
export const HANDOFF_SKILL = ".agents/skills/lane-listen/SKILL.md";

/** One line as a bullet of a hand-off: `- <id> <mark> <text>`. */
export function briefBullet(lane: RouteLane, l: Line): string {
  return `- ${l.id} ${lineMark(lane, l)} ${testText(l) ?? l.text}`;
}

/** The notes a batch carries once each: only STATE_TREE_NOTE, when it holds a state-tree line for this lane. */
export function batchNotes(lane: RouteLane, lines: readonly Line[]): string[] {
  return lines.some((l) => l.etaLane === lane) ? [STATE_TREE_NOTE] : [];
}

/**
 * A hand-off for one or more lines (several when the agent was busy and they
 * waited): a header with the lane and the newest line's time, one bullet per
 * line, and — only the first time in this listener's life — the rule and
 * where the rules are (firstLines).
 */
export function handoffBrief(
  lane: RouteLane,
  lines: readonly Line[],
  repo: string,
  first: boolean,
  o: UnnamedOpts = {},
): string {
  const at = ownerAt(lines.at(-1)?.at);
  // Only agents' and system lines (--everyone, --system): not his words, so not "owner →".
  const from = lines.some((l) => !l.kind && l.etaLane !== lane)
    ? "owner"
    : lines.every((l) => l.etaLane === lane)
      ? "state tree"
      : "chat";
  const out = [
    `【${from} → ${lane}】${at}`,
    ...lines.map((l) => briefBullet(lane, l)),
    ...batchNotes(lane, lines),
  ];
  if (first) out.push(...firstLines(lane, repo, o));
  return out.join("\n");
}

/** One line as its own hand-off (the same short form as a batch of one). */
export const handoff = (lane: RouteLane, l: Line, repo: string, o: UnnamedOpts = {}) =>
  handoffBrief(lane, [l], repo, false, o);

/** What only the first message of a listener's (or a woken reader's) life carries: the rule, and the skill path + reply command. */
export const firstLines = (lane: RouteLane, repo: string, o: UnnamedOpts = {}) => [
  o.answerUnnamed ? ANSWER_UNNAMED_RULE : NO_CROSS_RULE,
  `规则读一次：${join(repo, HANDOFF_SKILL)}；回复：bun ${join(repo, "scripts", "dev", "lianki-dev.ts")} reply --as ${lane} --id <id> "…"`,
];

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
  // An agent's or a system line never breaks in: FYI, whatever names it holds.
  if (l.kind) return false;
  return addressee(lane, l.text).to === "mine";
};
/** The body `ay send` still accepts: its own 1024 limit minus its ~150-char wrapper, with room for the header and the skill line. */
export const SEND_MAX_CHARS = 800;
/** A batch cut into parts whose bullets (and their batch note) stay under SEND_MAX_CHARS (`_o` is kept for callers; the text no longer depends on it); one bullet too long on its own is cut with "…". */
export function chunkLines(
  lane: RouteLane,
  lines: readonly Line[],
  max = SEND_MAX_CHARS,
  _o: UnnamedOpts = {},
): Line[][] {
  const parts: Line[][] = [];
  let cur: Line[] = [];
  let size = 0;
  const notes = (ls: readonly Line[]) => batchNotes(lane, ls).reduce((n, x) => n + x.length + 1, 0);
  for (const l of lines) {
    let line = l;
    const room = max - notes([l]);
    let len = briefBullet(lane, line).length + 1;
    if (len > room) {
      const over = len - room + 1;
      line = { ...l, text: `${l.text.slice(0, Math.max(0, l.text.length - over))}…` };
      len = briefBullet(lane, line).length + 1;
    }
    if (cur.length && size + len + notes([...cur, line]) > max) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(line);
    size += len;
  }
  if (cur.length) parts.push(cur);
  return parts;
}
export function makeDeliverer(
  o: { lane: RouteLane; repo: string } & UnnamedOpts,
  send: (body: string, interrupt: boolean) => Promise<number>,
  busy: () => Promise<boolean>,
  log: (v: Record<string, unknown>) => void = () => {},
  recheckMs = BUSY_RECHECK_MS,
  /** After each hand-over: its lines, and whether `ay send` took them (0 or 4). */
  sent: (lines: Line[], ok: boolean) => void = () => {},
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
    // `ay send` refuses a message over 1024 characters (its wrapper takes ~150),
    // and a refused batch was simply lost (2026-11-14 23:xx, four of coco's).
    // So a long batch goes as several messages, each under SEND_MAX_CHARS.
    let code: number | undefined;
    // The first message also carries firstLines: its parts leave room for them.
    const room = SEND_MAX_CHARS - (first ? firstLines(o.lane, o.repo, o).join("\n").length + 1 : 0);
    const unnamed = { answerUnnamed: o.answerUnnamed };
    for (const part of chunkLines(o.lane, batch, room, unnamed)) {
      code = await send(handoffBrief(o.lane, part, o.repo, first, unnamed), interrupt);
      first = false;
      log({ type: "delivered", lane: o.lane, ids: part.map((l) => l.id), interrupt, ay: code });
      const ok = code === 0 || code === 4;
      if (!ok) log({ type: "lost", lane: o.lane, ids: part.map((l) => l.id), ay: code });
      sent(part, ok);
    }
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

/** A listener that ran this long was a good connection: its next reconnect starts quick again. */
/** One row of `ay ls --json --local`, as far as picking a delivery target needs. */
export type AyRow = {
  pid?: number;
  cwd?: string;
  cli?: string;
  status?: string;
  started_at?: string | number | null;
};
/**
 * The agent a lane's lines go to when the listener was given a dir (`--cwd`)
 * and not a pid: the alive agents in that dir, of the lane's CLI kind when
 * known (`--cli`, from lanes.agents), the newest first. A dir may hold a stale
 * idle agent beside the live one, or another CLI (the chat lane's own session):
 * `ay send .` then refuses the ambiguous target and every line is lost
 * (杰咪, 2026-11-15 20:28 JST). Null when nothing matches.
 */
export function pickTarget(rows: readonly AyRow[], cwd: string, cli?: string): string | null {
  const alive = rows.filter(
    (r) =>
      typeof r.pid === "number" &&
      r.cwd === cwd &&
      r.status !== "exited" &&
      (!cli || r.cli === cli),
  );
  if (!alive.length) return null;
  const at = (r: AyRow) => {
    const v = r.started_at;
    const n = typeof v === "number" ? v : v ? Date.parse(String(v)) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  alive.sort((a, b) => at(b) - at(a) || (b.pid ?? 0) - (a.pid ?? 0));
  return String(alive[0]!.pid);
}

/**
 * The ay codes to try for one hand-off, in order. An urgent line breaks into the
 * turn with alt-m, but an ay without that key (v1.303, 2026-11-16 00:16 JST)
 * refuses the whole send and the line was lost: plain Enter follows it.
 */
export const sendCodes = (interrupt: boolean): string[] =>
  interrupt ? ["alt-m", "enter"] : ["enter"];
/** ay refused the key itself (not the target): try the next code. */
export const unknownCode = (stderr: string) => /unknown key\/code/i.test(stderr);

export const RECONNECT_RESET_MS = 60_000;

/**
 * The wait before the next reconnect, and the one after it. A socket that
 * lived RECONNECT_RESET_MS or more starts again at 1 s, so a drop after a
 * quiet night reconnects inside the hub's grace (lanes.modeGraceSec, 30 s)
 * and no "转为只读" is said; quick failures back off to 60 s (10 min on 5,
 * a refusal).
 */
export function reconnectWait(
  backoff: number,
  code: number,
  ranMs: number,
): { wait: number; next: number } {
  const wait = ranMs >= RECONNECT_RESET_MS ? 1_000 : backoff;
  return { wait, next: Math.min(wait * 2, code === 5 ? 600_000 : 60_000) };
}

// ── Delivered cursor and read receipts (docs/lane-listen.md "Read receipts") ──

const validSeq = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Where a lane keeps its delivered cursor: the last seq of the owner's thread it is done with. */
export const laneCursorPath = (lane: string, env?: Record<string, string | undefined>) =>
  join(laneTokenDir(env), `${lane}.seq`);

/** The saved cursor, or null when there is none yet (a first run starts from the live stream). */
export function readCursor(lane: string, env?: Record<string, string | undefined>): number | null {
  try {
    const n = Number(readFileSync(laneCursorPath(lane, env), "utf8").trim());
    return validSeq(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeCursor(lane: string, seq: number, env?: Record<string, string | undefined>) {
  if (!validSeq(seq)) return;
  try {
    mkdirSync(laneTokenDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(laneCursorPath(lane, env), `${seq}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * The delivered cursor. A line is passed (nothing to hand over: another
 * lane's, history, refused voice) or held until `ay send` took it. The
 * cursor is the highest seq with nothing held at or below it, so a line
 * lost in delivery keeps the cursor before it and the next connect's
 * recovery (`chat read --after-seq`) hands it over again. Seq gaps (lines
 * the hub never shows) are fine: only held lines stop the cursor.
 */
export function makeSeqCursor(start: number) {
  let max = start;
  const held = new Set<number>();
  const bump = (s: number) => {
    if (s > max) max = s;
  };
  return {
    pass(seq: number | undefined) {
      if (validSeq(seq)) bump(seq);
    },
    hold(seq: number | undefined) {
      if (!validSeq(seq) || seq <= start) return;
      held.add(seq);
      bump(seq);
    },
    /** Handed over: no longer holds the cursor. */
    release(seqs: readonly (number | undefined)[]) {
      for (const s of seqs) if (validSeq(s)) held.delete(s);
    },
    value(): number {
      let v = max;
      for (const s of held) if (s - 1 < v) v = s - 1;
      return v;
    },
  };
}

/**
 * The read receipt to post after a hand-over: through the newest line the
 * agent was handed, never past a line still held (the cursor). Null: no
 * receipt (nothing with a seq, or not past the last one posted).
 */
export function receiptAfter(
  delivered: readonly (number | undefined)[],
  cursor: number,
  last: number,
): number | null {
  const top = Math.max(-1, ...delivered.filter(validSeq));
  if (top < 0) return null;
  const at = Math.min(top, cursor);
  return at > last ? at : null;
}

/**
 * One receipt in flight at a time; a newer one waits and replaces any older
 * waiting one, so a burst of lines costs at most two posts.
 */
export function makeAcker(post: (seq: number) => Promise<boolean>) {
  let last = 0;
  let want = 0;
  let running: Promise<void> | null = null;
  const run = async () => {
    while (want > last) {
      const s = want;
      if (await post(s).catch(() => false)) last = Math.max(last, s);
      else break;
    }
    running = null;
  };
  return {
    ack(seq: number) {
      if (!validSeq(seq) || seq <= last) return running ?? Promise.resolve();
      want = Math.max(want, seq);
      running ??= run();
      return running;
    },
    last: () => last,
  };
}

/** Recovered lines older than this are passed, not handed over (a stale line answers nothing). */
export function recoverMaxMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.LANE_RECOVER_MAX_MIN);
  return (Number.isFinite(n) && n >= 0 ? n : 120) * 60_000;
}

/** The chat lines of a `lianki chat read --json` answer, as listener JSON lines. */
export function recoveredLines(stdout: string): string[] {
  try {
    const v = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
      data?: { messages?: unknown[] };
    };
    const list = Array.isArray(v?.data?.messages) ? v.data.messages : [];
    return list.map((message) => JSON.stringify({ type: "chat", message }));
  } catch {
    return [];
  }
}
