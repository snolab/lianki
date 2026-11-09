/**
 * ETA pings (docs/state-tree.md, "ETA pings" and "ETA overrun"): when a
 * state-tree node's estimate (`etaAt`, lib/progress.ts) runs out, the progress
 * hub (workers/push/src/progress.ts fireEta) asks the chat hub (debug.ts) to
 * put one line in the owner's thread, addressed to the agents. Shared so the
 * two hubs and the tests agree on the path, the body and the words.
 *
 * The line is automatic, never the owner's: `from: "agent"`, `agentId:
 * ETA_AGENT`, `source: "eta"`, and it can never answer an ask card (only a
 * tap on a page does: ask.ts). The "due" line, for the agents, is quiet
 * (shown, never read aloud); the owner's "late" and "silent" lines are not.
 */
import type { FlagKey } from "./flags";
import { PROGRESS_LIMITS, isProgressId } from "./progress";

/** The chat hub's internal route for a ping; reached only over the progress hub's binding. */
export const ETA_PATH = "/internal/eta";
/** The flag that turns the bar and the pings on (lib/flags.ts). */
export const ETA_FLAG = "chat.eta-bar" satisfies FlagKey;
/** Who an ETA line says it is from (its agentId and label). */
export const ETA_AGENT = "eta";
export const ETA_LABEL = "ETA timer (automatic)";
/** How long after the "due" line the owning lane has to give the reason and a new ETA. */
export const ETA_EXPLAIN_MS = 5 * 60_000;

/**
 * Which line. "due" (the default): the estimate ran out; tells the owning
 * lane what it must do. "late": the lane explained (`progress.ts --eta 20m
 * --late "…"`); tells the owner the reason and the new time. "silent": the
 * "due" line went out and ETA_EXPLAIN_MS later neither came; tells the owner.
 */
export type EtaPingKind = "due" | "late" | "silent";

/** What the progress hub sends the chat hub. */
export type EtaPing = {
  id: string;
  title: string;
  etaAt: number;
  assignee?: string;
  kind?: EtaPingKind;
  /** "late" only: the lane's reason. */
  reason?: string;
};

/** A title's name ("name: description"), as the owner's bar shows it. */
const nameOf = (title: string) => {
  const i = title.search(/[:：]/);
  const name = (i < 0 ? title : title.slice(0, i)).trim();
  return name || title.slice(i + 1).trim();
};

/**
 * The line's text. The owner's two are in the words he chose (2026-11-08
 * 20:24 JST); "late" gives the new time as whole minutes from `now`.
 */
export function etaLineText(p: EtaPing, now: number = Date.now()): string {
  const name = nameOf(p.title);
  if (p.kind === "silent") return `${name} 超时，未说明原因`;
  if (p.kind === "late") {
    const min = Math.max(1, Math.ceil((p.etaAt - now) / 60_000));
    return `${name} 超时：${p.reason ?? ""}。再要 ${min} 分钟`;
  }
  const lane = p.assignee ?? "<lane>";
  return (
    `ETA reached for ${p.title} (${p.id}): ${lane}, within ${ETA_EXPLAIN_MS / 60_000} min ` +
    `tell the owner WHY and a new "N minutes from now" — bun scripts/dev/progress.ts ` +
    `--agent ${lane} --path ${p.id} --task "<same>" --status doing --eta <N>m ` +
    `--late "<reason, in the owner's language>" (the hub posts both to him in Li). ` +
    `Otherwise he is told "${name} 超时，未说明原因".`
  );
}

/** A ping's body, checked; null if it is not one. */
export function parseEtaPing(raw: unknown): EtaPing | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (!isProgressId(b.id)) return null;
  if (typeof b.title !== "string" || !b.title.trim()) return null;
  if (typeof b.etaAt !== "number" || !Number.isFinite(b.etaAt)) return null;
  const assignee =
    typeof b.assignee === "string" ? b.assignee.slice(0, PROGRESS_LIMITS.name) : undefined;
  const kind = b.kind === "late" || b.kind === "silent" ? b.kind : undefined;
  const reason =
    typeof b.reason === "string" && b.reason.trim()
      ? b.reason.trim().slice(0, PROGRESS_LIMITS.late)
      : undefined;
  if (kind === "late" && !reason) return null;
  return {
    id: b.id,
    title: b.title.slice(0, PROGRESS_LIMITS.task),
    etaAt: b.etaAt,
    ...(assignee ? { assignee } : {}),
    ...(kind ? { kind } : {}),
    ...(kind === "late" ? { reason } : {}),
  };
}
