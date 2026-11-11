/**
 * ETA pings (docs/state-tree.md, "ETA pings", "ETA overrun", "Receipts"):
 * when a state-tree node's estimate (`etaAt`, lib/progress.ts) runs out, the
 * progress hub (workers/push/src/progress.ts fireEta) asks the chat hub
 * (debug.ts) to put one line in the owner's thread, addressed to the agents.
 * Shared so the two hubs and the tests agree on the path, the body and the
 * words.
 *
 * The line is automatic, never the owner's: `from: "agent"`, `agentId:
 * ETA_AGENT`, `source: "eta"`, and it can never answer an ask card (only a
 * tap on a page does: ask.ts). The lanes' lines ("due", "main", "blocked" on
 * a lane) are quiet (shown, never read aloud) and need a listener: with none
 * the chat hub does not post them and says "queued", and the progress hub
 * waits for one to connect. The owner's lines ("late", "silent", "waiting",
 * "blocked" on the owner) are read aloud and always posted.
 */
import type { FlagKey } from "./flags";
import { OWNER_NAME, PROGRESS_LIMITS, RECEIPT_RE, WHO_RE, isProgressId } from "./progress";

/** The chat hub's internal route for a ping; reached only over the progress hub's binding. */
export const ETA_PATH = "/internal/eta";
/**
 * The progress hub's internal route the chat hub calls when a listener
 * connects: queued lane lines go out then (the clock starts when one is heard).
 */
export const ETA_HEARD_PATH = "/internal/eta-heard";
/** The flag that turns the bar and the pings on (lib/flags.ts). */
export const ETA_FLAG = "chat.eta-bar" satisfies FlagKey;
/** Who an ETA line says it is from (its agentId and label). */
export const ETA_AGENT = "eta";
export const ETA_LABEL = "ETA timer (automatic)";
/**
 * The default of chat.etaAckMin: how long after the "due" line is heard the
 * owning lane has to ack it before the coordinating lane is told.
 */
export const ETA_EXPLAIN_MS = 5 * 60_000;

/**
 * Which line. "due" (the default): the estimate ran out; tells the owning
 * lane what it must do, with a receipt `code` to ack. "main": no ack came;
 * tells the coordinating lane (`lane`). "late": the lane explained
 * (`progress.ts --eta 20m --late "…"`); tells the owner the reason and the new
 * time. "silent": no reason and new time came; tells the owner (`n` ≥ 1: a
 * repeat, with backoff). "waiting": the node waits on the owner (#823's
 * spaced reminders, with `needs` as the reason). "blocked": the node is
 * blocked on `lane` ("owner" or a lane) with `reason` (its needs); nudged
 * with backoff.
 */
export type EtaPingKind = "due" | "main" | "late" | "silent" | "waiting" | "blocked";
export const ETA_PING_KINDS: readonly EtaPingKind[] = [
  "due",
  "main",
  "late",
  "silent",
  "waiting",
  "blocked",
];

/** What the progress hub sends the chat hub. */
export type EtaPing = {
  id: string;
  title: string;
  etaAt: number;
  assignee?: string;
  kind?: EtaPingKind;
  /** "late": the lane's reason (required). "waiting" / "blocked": what must be done (`needs`), if any. */
  reason?: string;
  /** "due" / "main": the receipt code (`progress.ts ack <code>`). */
  code?: string;
  /** "main": the coordinating lane. "blocked": who is nudged ("owner" or a lane). */
  lane?: string;
  /** "silent": the repeat number (absent: the first). "blocked": the nudge number. */
  n?: number;
  /** "due": minutes until the coordinating lane is told, then until the owner is. */
  ackMin?: number;
  ownerMin?: number;
};

/** A line the lanes act on (quiet; needs a listener), not one for the owner. */
export const forLanes = (p: EtaPing) =>
  (p.kind ?? "due") === "due" ||
  p.kind === "main" ||
  (p.kind === "blocked" && p.lane !== OWNER_NAME);

/** A title's name ("name: description"), as the owner's bar shows it. */
const nameOf = (title: string) => {
  const i = title.search(/[:：]/);
  const name = (i < 0 ? title : title.slice(0, i)).trim();
  return name || title.slice(i + 1).trim();
};

/** "40M", "1.5H", "2D": how long, as the owner reads times. */
export function compactSpan(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}M`;
  const h = min / 60;
  if (h < 48) return `${Number.isInteger(h) ? h : h.toFixed(1)}H`;
  return `${Math.round(h / 24)}D`;
}

/**
 * The line's text. The owner's are in the words he chose (2026-11-08 20:24
 * JST); "late" gives the new time as whole minutes from `now`, a "silent"
 * repeat how long it has been over.
 */
export function etaLineText(p: EtaPing, now: number = Date.now()): string {
  const name = nameOf(p.title);
  const lane = p.assignee ?? "<lane>";
  if (p.kind === "silent")
    return p.n
      ? `${name} 仍超时，未说明原因（已超 ${compactSpan(now - p.etaAt)}）`
      : `${name} 超时，未说明原因`;
  if (p.kind === "waiting") return p.reason ? `${name}：在等你——${p.reason}` : `${name}：在等你`;
  if (p.kind === "late") {
    const min = Math.max(1, Math.ceil((p.etaAt - now) / 60_000));
    return `${name} 超时：${p.reason ?? ""}。再要 ${min} 分钟`;
  }
  if (p.kind === "blocked") {
    if (p.lane === OWNER_NAME)
      return p.reason ? `${name} 卡住了，等你——${p.reason}` : `${name} 卡住了，等你`;
    return (
      `@${p.lane}: ${p.title} (${p.id}) is blocked on you${p.reason ? `: ${p.reason}` : ""}. ` +
      `${lane} cannot go on until you act; then tell ${lane}.`
    );
  }
  if (p.kind === "main")
    return (
      `@${p.lane}: ${lane} has not acked the ETA line for ${p.title} (${p.id}, receipt ${p.code}). ` +
      `Check on it: unless it reports a reason and a new ETA, the owner hears ` +
      `"${name} 超时，未说明原因"${p.ownerMin ? ` in ${p.ownerMin} min` : ""}.`
    );
  const ack = p.ackMin ?? ETA_EXPLAIN_MS / 60_000;
  const receipt = p.code
    ? ` Receipt ${p.code}: ack it now — bun scripts/dev/progress.ts ack ${p.code} (any report on ${p.id} counts too); no ack in ${ack} min and the coordinating lane is told.`
    : "";
  return (
    `ETA reached for ${p.title} (${p.id}): ${lane}, within ${ack} min ` +
    `tell the owner WHY and a new "N minutes from now" — bun scripts/dev/progress.ts ` +
    `--agent ${lane} --path ${p.id} --task "<same>" --status doing --eta <N>m ` +
    `--late "<reason, in the owner's language>" (the hub posts both to him in Li). ` +
    `Otherwise he is told "${name} 超时，未说明原因".${receipt}`
  );
}

const posInt = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : undefined;

/** A ping's body, checked; null if it is not one. */
export function parseEtaPing(raw: unknown): EtaPing | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (!isProgressId(b.id)) return null;
  if (typeof b.title !== "string" || !b.title.trim()) return null;
  if (typeof b.etaAt !== "number" || !Number.isFinite(b.etaAt)) return null;
  const assignee =
    typeof b.assignee === "string" ? b.assignee.slice(0, PROGRESS_LIMITS.name) : undefined;
  const kind =
    typeof b.kind === "string" &&
    b.kind !== "due" &&
    (ETA_PING_KINDS as readonly string[]).includes(b.kind)
      ? (b.kind as EtaPingKind)
      : undefined;
  const reason =
    typeof b.reason === "string" && b.reason.trim()
      ? b.reason.trim().slice(0, PROGRESS_LIMITS.late)
      : undefined;
  if (kind === "late" && !reason) return null;
  const code = typeof b.code === "string" && RECEIPT_RE.test(b.code) ? b.code : undefined;
  const lane = typeof b.lane === "string" && WHO_RE.test(b.lane) ? b.lane : undefined;
  if ((kind === "main" || kind === "blocked") && !lane) return null;
  const n = posInt(b.n, 10_000);
  const ackMin = posInt(b.ackMin, 1440);
  const ownerMin = posInt(b.ownerMin, 1440);
  return {
    id: b.id,
    title: b.title.slice(0, PROGRESS_LIMITS.task),
    etaAt: b.etaAt,
    ...(assignee ? { assignee } : {}),
    ...(kind ? { kind } : {}),
    ...((kind === "late" || kind === "waiting" || kind === "blocked") && reason ? { reason } : {}),
    ...((kind === undefined || kind === "main") && code ? { code } : {}),
    ...((kind === "main" || kind === "blocked") && lane ? { lane } : {}),
    ...((kind === "silent" || kind === "blocked") && n ? { n } : {}),
    ...((kind === undefined || kind === "main") && ackMin ? { ackMin } : {}),
    ...((kind === undefined || kind === "main") && ownerMin ? { ownerMin } : {}),
  };
}
