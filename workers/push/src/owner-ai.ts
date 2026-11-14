/**
 * Li in the owner's own thread (flag partner.owner-thread, docs/partner-ai.md,
 * "The owner's thread"): the model answers his line only when the dev lanes
 * leave it. Owner, 2026-11-15: "你把 Li 也叫上来，但是不要中断你自己的监听".
 *
 * A line qualifies when it is his (the caller passes only `from: "owner"`
 * lines), names no lane (`routeLine(text).addressed` false, no `to` node),
 * and its voiceprint did not decide it was another voice. The reply waits
 * `partner.ownerReplyDelayMs` (default 8 s) and is skipped when an agent line
 * arrived in his thread meanwhile: the lanes keep priority, Li fills the
 * silence. One pending reply at a time; any newer line of his replaces it.
 */
import { routeLine } from "../../../packages/debug-chat/src/lane-route";
import type { SpeakerTag } from "../../../packages/debug-chat/src/wire";
import {
  OWNER_REPLY_DELAY_KEY,
  OWNER_REPLY_DELAY_MAX,
  OWNER_REPLY_DELAY_MS,
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
};

/** Could Li answer this line of his at all (before the flags and the delay)? */
export function ownerLineWanted(l: OwnerLine): boolean {
  if (l.to) return false;
  if (l.speaker?.decision === "other") return false;
  return !routeLine(l.text).addressed;
}

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
  /** Answer this line now, for the page it came from (DebugHub.aiReply for his thread). */
  reply(l: OwnerLine, page: P): Promise<void>;
};

export class OwnerAi<P> {
  private pending?: { timer: unknown };
  private conf?: { at: number; on: boolean; delayMs: number };
  /** Counts his lines: a line whose flag read finished after a newer one began is dropped. */
  private seq = 0;

  constructor(private d: OwnerAiDeps<P>) {}

  /** The flag (only exactly true is on; unreadable = off) and the delay, cached. */
  async state(): Promise<{ on: boolean; delayMs: number }> {
    const t = this.d.now();
    if (this.conf && t - this.conf.at < CONF_MS) return this.conf;
    let on = false;
    try {
      on = (await this.d.flag(PARTNER_OWNER_FLAG)) === true;
    } catch {}
    let delayMs = OWNER_REPLY_DELAY_MS;
    try {
      const v = await this.d.config(OWNER_REPLY_DELAY_KEY);
      if (typeof v === "number" && Number.isFinite(v) && v >= 0)
        delayMs = Math.min(v, OWNER_REPLY_DELAY_MAX);
    } catch {}
    this.conf = { at: t, on, delayMs };
    return this.conf;
  }

  /** A new line of his was posted: drop any pending reply, and schedule one for it if it qualifies. */
  async line(l: OwnerLine, page: P): Promise<void> {
    this.cancel();
    const seq = ++this.seq;
    if (!ownerLineWanted(l)) return;
    const conf = await this.state();
    if (!conf.on || !(await this.d.aiOn())) return;
    // A newer line came in while the flags were read: that one decides.
    if (seq !== this.seq) return;
    const pending: { timer: unknown } = { timer: undefined };
    pending.timer = this.d.timer.set(() => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      // A lane answered within the delay: Li stays quiet.
      if (this.d.agentAt() >= l.at) return;
      this.d
        .reply(l, page)
        .catch((e) =>
          console.log(
            JSON.stringify({ msg: "partner.owner-failed", error: String(e).slice(0, 200) }),
          ),
        );
    }, conf.delayMs);
    this.pending = pending;
  }

  /** Drop the pending reply (a newer line of his). */
  cancel() {
    if (!this.pending) return;
    this.d.timer.clear(this.pending.timer);
    this.pending = undefined;
  }
}
