/**
 * Everyone's name is a wake word (docs/wake-word.md, "Names as wake words").
 *
 * Owner request, 2026-11-14 ~05:20 JST: not only "Linky": the names of
 * everyone taking part (the agents' and his own), following every rename
 * while the chat runs, as long as two names do not sound the same; a rename
 * itself is never refused.
 *
 * The set: LINKY first, then the lanes' names and aliases (voices.ts LANES:
 * coco, codex, 杰咪, agy, 小克, claude…), the main agent's name, the agents
 * present in the chat (presence.ts), and the owner's display name. Each name
 * becomes model tokens (wake-tokens.ts); one that cannot is skipped. Two
 * names clash when their tokens, stress and tone aside, are the same, one
 * starts the other, or (short ones) differ in one token: the one seen first
 * keeps it and the other is left out of the wake words (logged), nothing else.
 *
 * Pure except `wakeNames()`, the page's one store (on globalThis, so a
 * hot-swapped widget and the mic session share it). Tested in
 * unit/wake-names.test.ts.
 */
import { LANES, LANE_IDS } from "./voices";
import { type KeywordEntry, LINKY } from "./wake";
import { nameTokens, plainToken } from "./wake-tokens";

/** "agent": a name that addresses that agent (its line is prefixed); "owner": his own, wakes only. */
export type WakeNameKind = "agent" | "owner";
export type WakeParticipant = { name: string; kind: WakeNameKind };

/** A lane alias that is a word, not a name: never a wake word ("main", "chat"). */
export const NOT_NAMES: ReadonlySet<string> = new Set(["main", "chat"]);

/**
 * Names are untuned: the spotter's own defaults (score 1.0, threshold 0.25),
 * stricter than LINKY's 1.5 / 0.15, so a short name ("coco") wakes less on
 * near-misses until it is measured on his voice.
 */
export const NAME_SCORE = 1;
export const NAME_THRESHOLD = 0.25;
/** At or under this many tokens, a one-token difference is a clash ("coco" / "koko"). */
export const SHORT_TOKENS = 5;

/** Where the names come from; any may be missing. */
export type WakeNameSources = {
  /** The main agent's name (the host's: DebugChat's `t.name`). */
  mainName?: string;
  /** Names of the agents present in the chat (presence.ts Present.name). */
  agents?: readonly string[];
  /** The owner's own display name (the viewer's). */
  owner?: string;
};

/** The participants in priority order: lanes, main, agents present, the owner. */
export function wakeParticipants(src: WakeNameSources): WakeParticipant[] {
  const out: WakeParticipant[] = [];
  const add = (name: string | undefined, kind: WakeNameKind) => {
    const n = (name ?? "").trim();
    if (n && !NOT_NAMES.has(n.toLowerCase())) out.push({ name: n, kind });
  };
  for (const id of LANE_IDS) {
    add(LANES[id].name, "agent");
    for (const a of LANES[id].aliases) add(a, "agent");
  }
  add(src.mainName, "agent");
  for (const a of src.agents ?? []) add(a, "agent");
  add(src.owner, "owner");
  return out;
}

/** Token-level edit distance (Levenshtein). */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Do two token sequences sound the same to the spotter (stress and tone aside)? */
export function clashes(a: readonly string[], b: readonly string[]): boolean {
  const x = a.map(plainToken);
  const y = b.map(plainToken);
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.every((t, i) => t === l[i])) return true; // the same, or one starts the other
  return s.length <= SHORT_TOKENS && editDistance(x, y) <= 1;
}

export const AGENT_LABEL = "agent:";
export const OWNER_LABEL = "owner:";

/** One name that made it into the wake words. */
export type WakeName = WakeParticipant & { label: string; tokens: string[] };
export type WakeKeywordSet = {
  /** What the spotter gets: LINKY, then one entry per name. */
  entries: KeywordEntry[];
  names: WakeName[];
  /** Names with no tokens (another script, a rare character). */
  skipped: string[];
  /** Names left out because they sound like an earlier one. */
  clash: { name: string; with: string }[];
  /** The entries as one string: a change of it is a reload. */
  signature: string;
};

/**
 * The wake words for these participants (earlier ones win a clash). The same
 * name twice (any case) is one entry; a name that sounds like a LINKY
 * pronunciation clashes with "Linky".
 */
export function buildWakeKeywords(people: readonly WakeParticipant[]): WakeKeywordSet {
  const names: WakeName[] = [];
  const skipped: string[] = [];
  const clash: { name: string; with: string }[] = [];
  const seen = new Set<string>();
  for (const p of people) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const tokens = nameTokens(p.name);
    if (!tokens) {
      skipped.push(p.name);
      continue;
    }
    const linky = LINKY.matches.some((m) => clashes(m.tokens, tokens));
    const other = linky ? undefined : names.find((n) => clashes(n.tokens, tokens));
    if (linky || other) {
      clash.push({ name: p.name, with: linky ? "Linky" : other!.name });
      continue;
    }
    const label = `${p.kind === "owner" ? OWNER_LABEL : AGENT_LABEL}${p.name}`;
    names.push({ ...p, label, tokens });
  }
  const entries: KeywordEntry[] = [
    LINKY,
    ...names.map((n) => ({
      label: n.label,
      score: NAME_SCORE,
      threshold: NAME_THRESHOLD,
      matches: [{ tokens: n.tokens }],
    })),
  ];
  const signature = JSON.stringify(entries);
  return { entries, names, skipped, clash, signature };
}

/** Which name a detection's label is: null for LINKY (or anything else). */
export function heardName(label: string | undefined): WakeParticipant | null {
  if (!label) return null;
  if (label.startsWith(AGENT_LABEL)) return { name: label.slice(AGENT_LABEL.length), kind: "agent" };
  if (label.startsWith(OWNER_LABEL)) return { name: label.slice(OWNER_LABEL.length), kind: "owner" };
  return null;
}

/**
 * What goes before the words after the name, so the line is addressed to
 * that agent (lane-route.ts routeLine reads "coco, …"): "coco, " or "杰咪，".
 * Nothing for LINKY or the owner's own name.
 */
export function addressLead(label: string | undefined): string {
  const h = heardName(label);
  if (!h || h.kind !== "agent") return "";
  return /\p{Script=Han}$/u.test(h.name) ? `${h.name}，` : `${h.name}, `;
}

/**
 * The page's wake-name store. `set` takes the sources as they are now (a
 * rename, an agent joining); the set is rebuilt and listeners hear it only
 * when the keywords changed. Names keep the order they were first seen in,
 * so a newcomer (or a new name) never takes a sound from one already here.
 */
export function createWakeNames() {
  let src: WakeNameSources = {};
  /** First-seen order of names (lower case): earlier wins a clash. */
  const order: string[] = [];
  const listeners = new Set<(s: WakeKeywordSet) => void>();
  const rank = (n: string) => {
    const k = n.toLowerCase();
    let i = order.indexOf(k);
    if (i < 0) i = order.push(k) - 1;
    return i;
  };
  const compute = () => {
    const people = wakeParticipants(src);
    // Lanes' names are always first (fixed); the rest by when they were first seen.
    const lanes = wakeParticipants({}).length;
    for (const p of people) rank(p.name);
    const rest = people.slice(lanes).sort((a, b) => rank(a.name) - rank(b.name));
    return buildWakeKeywords([...people.slice(0, lanes), ...rest]);
  };
  let current = compute();
  return {
    get: () => current,
    set(next: WakeNameSources) {
      src = next;
      const s = compute();
      const same = s.signature === current.signature;
      current = s; // its skipped and clash lists are news even when the words are not
      if (same) return false;
      for (const f of listeners) f(s);
      return true;
    },
    subscribe(f: (s: WakeKeywordSet) => void) {
      listeners.add(f);
      return () => void listeners.delete(f);
    },
  };
}
export type WakeNames = ReturnType<typeof createWakeNames>;

const KEY = "__lkWakeNames";
/** The page's one store (shared by every copy of the widget and the mic session). */
export function wakeNames(): WakeNames {
  const g = globalThis as unknown as Record<string, WakeNames | undefined>;
  return (g[KEY] ??= createWakeNames());
}
