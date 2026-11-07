/**
 * ETA pings (docs/state-tree.md, "ETA pings"): when a state-tree node's
 * estimate (`etaAt`, lib/progress.ts) runs out, the progress hub
 * (workers/push/src/progress.ts fireEta) asks the chat hub (debug.ts) to put
 * one line in the owner's thread, addressed to the agents. Shared so the two
 * hubs and the tests agree on the path, the body and the words.
 *
 * The line is automatic, never the owner's: `from: "agent"`, `agentId:
 * ETA_AGENT`, `source: "eta"`, quiet (shown, never read aloud), and it can
 * never answer an ask card (only a tap on a page does: ask.ts).
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

/** What the progress hub sends the chat hub. */
export type EtaPing = { id: string; title: string; etaAt: number; assignee?: string };

/** The line the agents read. */
export const etaLineText = (p: Pick<EtaPing, "id" | "title">) =>
  `ETA reached for ${p.title} (${p.id}): report to the owner`;

/** A ping's body, checked; null if it is not one. */
export function parseEtaPing(raw: unknown): EtaPing | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (!isProgressId(b.id)) return null;
  if (typeof b.title !== "string" || !b.title.trim()) return null;
  if (typeof b.etaAt !== "number" || !Number.isFinite(b.etaAt)) return null;
  const assignee =
    typeof b.assignee === "string" ? b.assignee.slice(0, PROGRESS_LIMITS.name) : undefined;
  return {
    id: b.id,
    title: b.title.slice(0, PROGRESS_LIMITS.task),
    etaAt: b.etaAt,
    ...(assignee ? { assignee } : {}),
  };
}
