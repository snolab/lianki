/**
 * The pure pieces of `bun scripts/dev/eval.ts working` — the agent's heartbeat
 * behind the chat's "agent is working" spinner (docs/monitoring.md, "Agent is
 * working"). No I/O here: eval.ts does the socket, the timer and stdin.
 */
import { WORKING_MS } from "../../lib/dev-eval";

export type WorkingArgs = {
  to?: string;
  label?: string;
  /** Seconds between beats; absent = send one beat and exit. */
  every?: number;
  /** Stop at the next agent reply in the beat's thread (default with --every). */
  untilSay: boolean;
  /** Give up after this many seconds even if nobody stops it. */
  maxSeconds: number;
};

/** A forgotten beat loop stops on its own after this long. */
export const WORKING_MAX_S = 30 * 60;
/** Longest gap between beats that still keeps the spinner up. */
export const WORKING_EVERY_MAX = Math.floor(WORKING_MS / 1000) - 2;

/**
 * Parse `working [--to <email>] [--label X] [--every <s>] [--keep] [--max <s>]`
 * (everything after the word `working`).
 */
export function parseWorkingArgs(argv: string[]): WorkingArgs | { error: string } {
  const out: WorkingArgs = { untilSay: true, maxSeconds: WORKING_MAX_S };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "--to") out.to = val();
      else if (a === "--label") out.label = val();
      else if (a === "--every" || a === "--max") {
        const n = Number(val());
        if (!Number.isFinite(n) || n <= 0) return { error: `${a} needs a number of seconds` };
        if (a === "--max") out.maxSeconds = n;
        else if (n > WORKING_EVERY_MAX)
          return { error: `--every must be at most ${WORKING_EVERY_MAX} s, or the spinner lapses` };
        else out.every = Math.max(1, n);
      } else if (a === "--until-say") out.untilSay = true;
      else if (a === "--keep") out.untilSay = false;
      else return { error: `unknown argument ${a}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  return out;
}

/** The beat sent to the hub. */
export const beatMessage = (a: Pick<WorkingArgs, "to" | "label">) =>
  JSON.stringify({
    type: "working",
    ...(a.to ? { to: a.to } : {}),
    ...(a.label ? { label: a.label } : {}),
  });

/**
 * Whether a message the hub sent the beat loop is an agent reply in its own
 * thread (`thread` from the hub's first {type:"beat"} ack) — the cue to stop.
 */
export function endsBeat(m: Record<string, unknown>, thread: string | undefined): boolean {
  if (!thread || m.type !== "chat" || !m.message || typeof m.message !== "object") return false;
  const msg = m.message as { from?: unknown; thread?: unknown };
  return msg.from === "agent" && (msg.thread ?? "owner") === thread;
}
