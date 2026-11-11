/**
 * Where a sender CLI (eval.ts) sits in the state tree: `--task-path` /
 * LIANKI_TASK_PATH (its node) and `--agent` / LIANKI_AGENT (the node's
 * assignee). A sub-agent sets the env vars once; the flags win over them.
 * docs/dev-debug-widget.md, "Node paths".
 */
import { ROOT_NODE, agentIdOf, nodePath } from "@/lib/dev-eval";
import { LANE_IDS, type LaneId, isLaneId, parseLineVoice } from "@/packages/debug-chat/src/voices";
import { parsePlay } from "@/packages/debug-chat/src/play-audio";

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
    // "eta": automatic, from the hubs when a state-tree estimate ran out (lib/eta-ping.ts).
    // Not the owner speaking, never an answer or an approval: report on that node to him.
    ...(m.source === "eta"
      ? { source: "eta", auto: true, ...(m.eta && typeof m.eta === "object" ? { eta: m.eta } : {}) }
      : {}),
    // A voice line's timestamps on the page's clock (VoiceTiming; latency.ts).
    ...(m.timing && typeof m.timing === "object" ? { timing: m.timing } : {}),
    // Which recognizer made a voice line's text: {route: "local"|"cloud", engine?, fallback?}.
    ...(m.stt && typeof m.stt === "object" ? { stt: m.stt } : {}),
    // The mic's wake-word mode when it was sent (docs/wake-word.md), and why it was in it.
    ...(m.wake === "active" || m.wake === "passive" ? { wake: m.wake } : {}),
    ...(typeof m.wakeReason === "string" ? { wakeReason: m.wakeReason } : {}),
    ...(m.edited && typeof m.edited === "object" ? { raw: m.raw, edited: m.edited } : {}),
    // Continuous speech (stt.merge): how many utterances the line is made of.
    ...(Array.isArray(m.parts) ? { parts: m.parts.length } : {}),
    // Attached with the + menu (attach.ts): {selection, path?, title?, host?}.
    ...(m.context && typeof m.context === "object" ? { context: m.context } : {}),
    // Files sent with the line: [{id,name,type,size}]; fetch one with `eval.ts inbox get <id>`.
    ...(Array.isArray(m.attachments) ? { attachments: m.attachments } : {}),
    // A voice line's page and screen text: what `eval.ts edit` may draw on (polish.ts).
    ...(m.scene && typeof m.scene === "object" ? { scene: m.scene } : {}),
    ...(observed ? { observed: true } : {}),
  };
}

/** Whether a `say` is read aloud: `--quiet` = shown, never read aloud. */
export type SayVolume = { quiet?: true };

/** The say's flags as sent to the hub. */
export function sayVolume(f: { quiet: boolean }): SayVolume {
  return f.quiet ? { quiet: true } : {};
}

/** A say's lane and voice as sent to the hub (packages/debug-chat/src/voices.ts). */
export type SayLane = { lane?: LaneId; voice?: string };

/**
 * `--lane` / `--voice` checked: a lane of the table, a voice the strict
 * parser takes (voices.ts parseLineVoice: main|calm|bright, device:<name>,
 * melo:<lang>, aura:<speaker>, eleven:<id>). An unknown one is an error, never dropped.
 */
export function sayLane(lane?: string, voice?: string): SayLane | { error: string } {
  if (lane !== undefined && !isLaneId(lane))
    return { error: `unknown --lane ${lane}: one of ${LANE_IDS.join(", ")}` };
  const v = voice === undefined ? undefined : parseLineVoice(voice);
  if (v && "error" in v) return { error: `--voice: ${v.error}` };
  return { ...(lane ? { lane } : {}), ...(voice ? { voice } : {}) };
}

/** A say's audio as sent to the hub (play-audio.ts; docs/li-sound-hub.md, "Playing audio from an agent"). */
export type SayPlay = { audio?: { src: string; title?: string; kind?: string } };

/**
 * `--play <src>` (with `--title`, `--kind`) checked by the same parser the hub
 * uses (play-audio.ts parsePlay): an https URL with a public host name, or
 * file:<id>. The deny list and the permission are the hub's; a bad src is an
 * error here, before a socket opens.
 */
export function sayPlay(play?: string, title?: string, kind?: string): SayPlay | { error: string } {
  if (play === undefined) {
    if (title !== undefined || kind !== undefined)
      return { error: "--title and --kind go with --play <src>" };
    return {};
  }
  const p = parsePlay({ src: play, title, kind });
  if (!p.ok) return { error: p.error };
  return {
    audio: {
      src: p.audio.src,
      ...(p.audio.title ? { title: p.audio.title } : {}),
      ...(kind !== undefined ? { kind: p.audio.kind } : {}),
    },
  };
}

/** Printed (stderr) when an old command still passes `say --loud`: it does nothing now. */
export const LOUD_DEPRECATED =
  "say --loud is deprecated and does nothing (a plain say); it is accepted so old commands still work";
