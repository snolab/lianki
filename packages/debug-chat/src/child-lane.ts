/**
 * Child tokens' names (lib/api-token-child.ts; docs/secrets-and-auth.md,
 * "Child tokens"): a lane's subagent posts with a token named
 * `<parent>·<sub>`, e.g. "claude·子1". The hub labels its lines with that
 * name; this shows it with the parent lane's own name, 「小克·子1」, and its
 * avatar is the parent lane's mark with a small index.
 *
 * Display only: the name grants nothing (the token's permissions are checked
 * by lib/api-tokens.ts), and a child never becomes its parent lane (`lane` is
 * never set on its lines, so asks, answers and routing stay its own).
 */
import { type LaneId, laneOf, laneSpec } from "./voices";

/** Between the parent's name and the subagent's: a middle dot. */
export const CHILD_SEP = "·";
/** The longest subagent name, in characters. */
export const CHILD_SUB_MAX = 12;

export type ChildLane = {
  /** The parent token's name, as written ("claude"). */
  parent: string;
  /** The parent's built-in lane (voices.ts), when it names one. */
  lane: LaneId | null;
  /** The subagent's own name ("子1"). */
  sub: string;
};

/** A child token's name split at its first `·`; null for any other name. */
export function childLane(name: unknown): ChildLane | null {
  if (typeof name !== "string") return null;
  const at = name.indexOf(CHILD_SEP);
  if (at <= 0) return null;
  const parent = name.slice(0, at);
  const sub = name.slice(at + 1);
  if (!sub || sub.includes(CHILD_SEP) || [...sub].length > CHILD_SUB_MAX) return null;
  return { parent, lane: laneOf({ text: `【${parent}】` }).lane, sub };
}

/** The parent's shown name: its lane's ("小克" for claude), else the parent token's. */
export function parentShownName(c: ChildLane): string {
  return (c.lane && laneSpec(c.lane).name) || c.parent;
}

/** How a child's lines are labelled: 「小克·子1」; any other name unchanged. */
export function childShownName(name: string): string {
  const c = childLane(name);
  return c ? `${parentShownName(c)}${CHILD_SEP}${c.sub}` : name;
}

/**
 * The small index on a child's avatar: the digits its name ends with
 * ("子1" → "1"), else 1–9 from the name, so a name keeps its index.
 */
export function childIndex(sub: string): string {
  const d = /(\d{1,2})$/.exec(sub);
  if (d) return d[1]!;
  let h = 0;
  for (const ch of sub) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return String((h % 9) + 1);
}
