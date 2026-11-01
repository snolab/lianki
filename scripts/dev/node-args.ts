/**
 * Where a sender CLI (eval.ts) sits in the state tree: `--task-path` /
 * LIANKI_TASK_PATH (its node) and `--agent` / LIANKI_AGENT (the node's
 * assignee). A sub-agent sets the env vars once; the flags win over them.
 * docs/dev-debug-widget.md, "Node paths".
 */
import { ROOT_NODE, agentIdOf, nodePath } from "@/lib/dev-eval";

export type NodeOpts = { node?: string; agent?: string };

export function nodeOpts(
  flags: { taskPath?: string; agent?: string },
  env: Record<string, string | undefined> = process.env,
): NodeOpts | { error: string } {
  const rawPath = flags.taskPath ?? env.LIANKI_TASK_PATH;
  const rawAgent = flags.agent ?? env.LIANKI_AGENT;
  const node = rawPath?.trim() ? nodePath(rawPath) : undefined;
  if (rawPath?.trim() && !node)
    return { error: `not a node path: ${rawPath} (letters, digits, ._~- segments, ≤ 80 chars)` };
  const agent = rawAgent?.trim() ? agentIdOf(rawAgent) : undefined;
  if (rawAgent?.trim() && !agent)
    return { error: `not an agent id: ${rawAgent} (≤ 40 chars of letters, digits, ._@:+- )` };
  return {
    ...(node && node !== ROOT_NODE ? { node } : {}),
    ...(agent ? { agent } : {}),
  };
}

/**
 * One chat line as `eval.ts chat` prints it, or null when it is not for this
 * listener's agent: its own lines, and agent lines not addressed to a node
 * (the agents' replies to the owner) are skipped, as before node paths.
 */
export function chatLine(
  m: Record<string, unknown>,
  self: NodeOpts,
  observed: boolean,
): Record<string, unknown> | null {
  if (m.from === "agent") {
    if (typeof m.to !== "string") return null;
    if ((m.taskPath ?? ROOT_NODE) === (self.node ?? ROOT_NODE) && m.agentId === self.agent)
      return null;
  }
  return {
    type: "chat",
    id: m.id,
    thread: m.thread ?? "owner",
    email: m.email ?? null,
    from: m.from,
    text: m.text,
    at: new Date(Number(m.at)).toISOString(),
    label: m.label,
    ...(typeof m.to === "string" ? { to: m.to } : {}),
    ...(typeof m.taskPath === "string" ? { taskPath: m.taskPath } : {}),
    ...(typeof m.agentId === "string" ? { agentId: m.agentId } : {}),
    // "stt": spoken into the widget's mic, so `eval.ts edit` may polish it.
    ...(m.source === "stt" ? { source: "stt" } : {}),
    // A voice line's timestamps on the page's clock (VoiceTiming; latency.ts).
    ...(m.timing && typeof m.timing === "object" ? { timing: m.timing } : {}),
    ...(m.edited && typeof m.edited === "object" ? { raw: m.raw, edited: m.edited } : {}),
    ...(observed ? { observed: true } : {}),
  };
}

/** Whether a `say` is read aloud: `--quiet` = shown, never read aloud. */
export type SayVolume = { quiet?: true };

/** The say's flags as sent to the hub. */
export function sayVolume(f: { quiet: boolean }): SayVolume {
  return f.quiet ? { quiet: true } : {};
}

/** Printed (stderr) when an old command still passes `say --loud`: it does nothing now. */
export const LOUD_DEPRECATED =
  "say --loud is deprecated and does nothing (a plain say); it is accepted so old commands still work";
