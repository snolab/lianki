/**
 * Li in the owner's own thread (flag partner.owner-thread, docs/partner-ai.md,
 * "The owner's thread"): the model answers his line only when the dev lanes
 * leave it. Owner, 2026-11-15: "你把 Li 也叫上来，但是不要中断你自己的监听".
 *
 * A line qualifies when it is his (the caller passes only `from: "owner"`
 * lines), names no lane (`routeLine(text).addressed` false, no `to` node),
 * and, when it came through a microphone, its voiceprint decided it was his
 * ("me"); an "other" or "unknown" voice gets no reply (2026-11-15 04:05 JST:
 * Li answered ambient speech marked unknown). A typed line has no speaker tag
 * and qualifies. The reply waits
 * `partner.ownerReplyDelayMs` (default 30 s) and is skipped when an agent line
 * arrived in his thread meanwhile: the lanes keep priority, Li fills the
 * silence. One pending reply at a time; any newer line of his replaces it.
 */
import { namesLane } from "../../../packages/debug-chat/src/lane-route";
import type { SpeakerTag } from "../../../packages/debug-chat/src/wire";
import {
  OWNER_LANE_ACTIVE_KEY,
  OWNER_LANE_ACTIVE_MAX,
  OWNER_LANE_ACTIVE_MS,
  OWNER_LI_NAMES,
  OWNER_LI_NAMES_KEY,
  OWNER_QUIET_KEY,
  OWNER_QUIET_MAX,
  OWNER_QUIET_MS,
  OWNER_REPLY_DELAY_KEY,
  OWNER_REPLY_DELAY_MAX,
  OWNER_REPLY_DELAY_MS,
  OWNER_SPOKEN_NEEDS_NAME,
  OWNER_SPOKEN_NEEDS_NAME_KEY,
  OWNER_STOP_PHRASES,
  OWNER_STOP_PHRASES_KEY,
  PARTNER_OWNER_FLAG,
} from "../../../lib/partner-ai-config";
import type { HubTimer } from "./debug";

/** How long a read of the flag and the delay is trusted. */
const CONF_MS = 30_000;

export type OwnerLine = {
  id: string;
  text: string;
  at: number;
  /** A node address (`to`): the line is for that node's lane, not Li. */
  to?: string;
  speaker?: Pick<SpeakerTag, "decision">;
  /** "stt": heard by a microphone (the room may be talking); absent = typed. */
  source?: string;
};

/**
 * Could Li answer this line of his at all (before the flags and the delay)?
 * Not when it names a lane anywhere, heard spellings included (namesLane):
 * 2026-11-16, Li answered "韩今明要实施监控这个页面的改动", meant for 哈基米.
 */
export function ownerLineWanted(l: OwnerLine): boolean {
  if (l.to) return false;
  if (l.speaker && l.speaker.decision !== "me") return false;
  return !namesLane(l.text);
}

/** Does the line hold one of the stop phrases (case-insensitive, anywhere)? */
export function isStopLine(text: string, phrases: readonly string[] = OWNER_STOP_PHRASES): boolean {
  const t = text.toLowerCase();
  return phrases.some((p) => p.trim() !== "" && t.includes(p.trim().toLowerCase()));
}

/** After a name: nothing, or a mark or a space (a Latin name must not run on into a word). */
const LI_AFTER = /^(?:$|[\s,，、:：.。!！?？~～—–-])/u;
/** Does the line start by naming Li ("Li，…", "@Li 在吗", "学习伙伴：…")? */
export function addressesLi(text: string, names: readonly string[] = OWNER_LI_NAMES): boolean {
  const t = text.replace(/^[\s@,，、:：.。!！~～-]+/u, "").toLowerCase();
  return names.some((n) => {
    const name = n.trim().toLowerCase();
    return name !== "" && t.startsWith(name) && LI_AFTER.test(t.slice(name.length));
  });
}

/**
 * Does the line name Li anywhere (a spoken line: "…，Li 你说呢")? Latin names
 * as whole words ("Li" not in "like"), the others as written.
 */
export function namesLi(text: string, names: readonly string[] = OWNER_LI_NAMES): boolean {
  if (addressesLi(text, names)) return true;
  const t = text.toLowerCase();
  return names.some((n) => {
    const name = n.trim().toLowerCase();
    if (!name) return false;
    if (!/^[a-z ]+$/.test(name)) return t.includes(name);
    for (let i = t.indexOf(name); i >= 0; i = t.indexOf(name, i + 1))
      if (!/[a-z0-9]/.test(t[i - 1] ?? "") && !/[a-z0-9]/.test(t[i + name.length] ?? ""))
        return true;
    return false;
  });
}

type Conf = {
  at: number;
  on: boolean;
  spokenNeedsName: boolean;
  delayMs: number;
  quietMs: number;
  laneActiveMs: number;
  stop: readonly string[];
  liNames: readonly string[];
};

const ms = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : undefined;
const words = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

export type OwnerAiDeps<P> = {
  now(): number;
  timer: HubTimer;
  /** A flag's value from the main Worker; throws when it cannot be read (= off). */
  flag(key: string): Promise<unknown>;
  /** A live config value from the main Worker (undefined = its default). */
  config(key: string): Promise<unknown>;
  /** Is partner.ai-reply itself on (the hub's cached read)? */
  aiOn(): Promise<boolean>;
  /** When an agent line last arrived in his thread (0 = never). */
  agentAt(): number;
  /** When a lane's line (an agent line that is neither Li's nor a hub notice) last arrived in his thread; absent = never. */
  laneAt?(): number;
  /** Where the decision lines go (default console.log). */
  log?(line: string): void;
  /** Answer this line now, for the page it came from (DebugHub.aiReply for his thread). */
  reply(l: OwnerLine, page: P): Promise<void>;
  /** Post Li's roll-call answer at once (no model): config partner.rollCallReply over who is here. */
  present(l: OwnerLine, page: P): Promise<void>;
};

/**
 * A roll call (owner, 2026-11-15 04:51 JST "报数也应该包括 Li"), anywhere in
 * his line: 报数 / 点名, his "全体都有" / "都有报…", and how speech-to-text
 * wrote 报数 for him (13:1x JST: "小朋友们全体都有包书一" → 包书; 报树).
 */
export const ROLL_CALL = /报数|点名|包书|报树|全体都有|都有报/;
/** The 全体 forms count at any length; the bare words only in a short line (owner, 2026-11-15: "我点名的时候…" is a rule, not a roll call). */
export const ROLL_CALL_ALL = /全体都有|都有报|全体.{0,6}(报数|点名|包书|报树)/;
export const ROLL_CALL_MAX = 14;
/** A line that ENDS with the word ("@小克 @coco 报数", "大家报树。") is a roll call at any length. */
export const ROLL_CALL_END = /(报数|点名|包书|报树|报树一|包书一)[。！!．.\s]*$/;
export function isRollCall(text: string): boolean {
  const t = text.trim();
  if (ROLL_CALL_ALL.test(t)) return true;
  if (ROLL_CALL_END.test(t)) return true;
  return t.length <= ROLL_CALL_MAX && ROLL_CALL.test(t);
}

/**
 * Which rule set this hub runs, in every decision log: after a deploy,
 * `wrangler tail lianki-push` shows whether the live object has the new code
 * (2026-11-16: a reply after the deploy matched the rules before it).
 */
export const OWNER_AI_RULES = "2026-11-16.spoken";

export class OwnerAi<P> {
  private pending?: { timer: unknown };
  private conf?: Conf;
  /** Counts his lines: a line whose flag read finished after a newer one began is dropped. */
  private seq = 0;
  /** Li keeps silent until then (a stop line of his), unless he names Li. */
  private quietUntil = 0;

  constructor(private d: OwnerAiDeps<P>) {}

  /** Is Li in a quiet spell (he told it to stop)? */
  quiet(): boolean {
    return this.d.now() < this.quietUntil;
  }

  private async read(key: string): Promise<unknown> {
    try {
      return await this.d.config(key);
    } catch {
      return undefined;
    }
  }

  /** The flag (only exactly true is on; unreadable = off) and the live values, cached. */
  async state(): Promise<Conf> {
    const t = this.d.now();
    if (this.conf && t - this.conf.at < CONF_MS) return this.conf;
    let on = false;
    try {
      on = (await this.d.flag(PARTNER_OWNER_FLAG)) === true;
    } catch {}
    const [delay, quiet, active, stop, liNames, spoken] = await Promise.all([
      this.read(OWNER_REPLY_DELAY_KEY),
      this.read(OWNER_QUIET_KEY),
      this.read(OWNER_LANE_ACTIVE_KEY),
      this.read(OWNER_STOP_PHRASES_KEY),
      this.read(OWNER_LI_NAMES_KEY),
      this.read(OWNER_SPOKEN_NEEDS_NAME_KEY),
    ]);
    this.conf = {
      at: t,
      on,
      spokenNeedsName: typeof spoken === "boolean" ? spoken : OWNER_SPOKEN_NEEDS_NAME,
      delayMs: ms(delay, OWNER_REPLY_DELAY_MAX) ?? OWNER_REPLY_DELAY_MS,
      quietMs: ms(quiet, OWNER_QUIET_MAX) ?? OWNER_QUIET_MS,
      laneActiveMs: ms(active, OWNER_LANE_ACTIVE_MAX) ?? OWNER_LANE_ACTIVE_MS,
      stop: words(stop) ?? OWNER_STOP_PHRASES,
      liNames: words(liNames) ?? OWNER_LI_NAMES,
    };
    return this.conf;
  }

  /** A new line of his was posted: drop any pending reply, and schedule one for it if it qualifies. */
  async line(l: OwnerLine, page: P): Promise<void> {
    this.cancel();
    const seq = ++this.seq;
    // A roll call names the lanes, so it is never "wanted"; Li still answers it, at once,
    // with the flag on (partner.ai-reply is not needed: no model is called).
    if (isRollCall(l.text) && !l.to && l.speaker?.decision !== "other") {
      if ((await this.state()).on && seq === this.seq)
        await this.d.present(l, page).catch((e) =>
          console.log(
            JSON.stringify({
              msg: "partner.owner-rollcall-failed",
              error: String(e).slice(0, 200),
            }),
          ),
        );
      return;
    }
    if (l.to || l.speaker?.decision === "other") return this.skip(l, l.to ? "node" : "other-voice");
    const conf = await this.state();
    const why = this.decide(l, conf);
    if (why) return this.skip(l, why);
    if (!conf.on || !(await this.d.aiOn())) return this.skip(l, "off");
    // A newer line came in while the flags were read: that one decides.
    if (seq !== this.seq) return this.skip(l, "newer");
    const pending: { timer: unknown } = { timer: undefined };
    pending.timer = this.d.timer.set(() => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      // A lane answered within the delay: Li stays quiet.
      if (this.d.agentAt() >= l.at) return this.skip(l, "answered");
      this.d
        .reply(l, page)
        .catch((e) =>
          console.log(
            JSON.stringify({ msg: "partner.owner-failed", error: String(e).slice(0, 200) }),
          ),
        );
    }, conf.delayMs);
    this.pending = pending;
    this.log({
      msg: "partner.owner-scheduled",
      id: l.id,
      rules: OWNER_AI_RULES,
      delayMs: conf.delayMs,
    });
  }

  /**
   * Why Li must not answer this line (null = it may): the rules after the flags.
   * A stop line starts a quiet spell; a direct address ends one.
   */
  private decide(l: OwnerLine, conf: Conf): string | null {
    // "没问你" / "闭嘴" (owner, 2026-11-16: "我已经要求他闭嘴了"): Li keeps silent a while.
    // A stop line that names a lane ("哈基米，别说了") is for that lane, not Li.
    if (isStopLine(l.text, conf.stop) && !namesLane(l.text)) {
      this.quietUntil = this.d.now() + conf.quietMs;
      return "stop";
    }
    if (!ownerLineWanted(l)) return l.speaker ? "voice-not-his" : "names-lane";
    // A spoken line: the room may be talking (2026-11-16: "あります。", "And here a few."
    // got a reply). Li is in the room, silent until named (partner.spokenNeedsName).
    const spoken = l.source === "stt";
    if (spoken && conf.spokenNeedsName && !namesLi(l.text, conf.liNames)) return "spoken-unnamed";
    const direct = spoken ? namesLi(l.text, conf.liNames) : addressesLi(l.text, conf.liNames);
    if (direct) {
      this.quietUntil = 0;
      return null;
    }
    if (this.quiet()) return "quiet";
    // A lane is talking with him: his unaddressed line is most likely for it.
    const laneAt = this.d.laneAt?.() ?? 0;
    if (conf.laneActiveMs > 0 && laneAt > 0 && this.d.now() - laneAt < conf.laneActiveMs)
      return "lane-active";
    return null;
  }

  /** One log line per decision: the line's id and the rule, never its text (wrangler tail). */
  private skip(l: OwnerLine, reason: string): void {
    this.log({ msg: "partner.owner-skip", id: l.id, rules: OWNER_AI_RULES, reason });
  }

  private log(o: Record<string, unknown>) {
    (this.d.log ?? ((s: string) => console.log(s)))(JSON.stringify(o));
  }

  /** Drop the pending reply (a newer line of his). */
  cancel() {
    if (!this.pending) return;
    this.d.timer.clear(this.pending.timer);
    this.pending = undefined;
  }
}
