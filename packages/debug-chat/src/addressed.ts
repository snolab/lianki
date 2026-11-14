/**
 * Who the owner called (owner, 2026-11-14 03:40 JST): "when I speak and a
 * lane's name matches ('codex' / 'coco'), that lane's avatar should flash in
 * the chat box". The names and their heard spellings are lane-route.ts's, the
 * very rule the listeners route by, so the avatar that flashes is the lane
 * that answers. A line with no name flashes nothing (it goes to the chat lane
 * by default, but nobody was called).
 *
 * Once per utterance: the live interim text flashes a lane as soon as its
 * name is heard, and neither the following interims nor the sent line flash
 * it again; the sent line ends the utterance. An utterance left unsent ends
 * after UTTERANCE_GAP_MS without a word.
 *
 * Pure, tested in unit/chat-addressed.test.ts; DebugChat.tsx draws it.
 */
import { routeLine, type RouteLane } from "./lane-route";
import { LANES, type LaneId } from "./voices";

/** The chat lane that answers for each route lane: "chat" is 小克's (xiaoke / 小可 / 小克). */
export const ROUTE_TO_LANE: Readonly<Record<RouteLane, LaneId>> = {
  chat: "claude",
  codex: "codex",
  agy: "agy",
};

/** The lanes `text` addresses by name, in the order named; [] when it names none. */
export function addressedLanes(text: unknown): LaneId[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const r = routeLine(text);
  return r.addressed ? r.lanes.map((l) => ROUTE_TO_LANE[l]) : [];
}

/** How long a flash lasts: the pulse runs twice in it; reduced motion holds a still ring as long. */
export const FLASH_MS = 1200;
/** No interim word for this long and nothing sent: the utterance is over. */
export const UTTERANCE_GAP_MS = 4000;

/** The ring's colour for a lane: its mark's disc, or the current text colour without a mark. */
export const ringOf = (lane: LaneId): string => LANES[lane].mark?.bg ?? "currentColor";

/** Set on an element while it flashes; `--lk-ring` carries the lane's colour. */
export const FLASH_ATTR = "data-lk-flash";

/**
 * The pulse: a ring in the lane's colour swelling out twice over FLASH_MS
 * with a small scale. Its own keyframes (the hot-loaded widget has no app
 * stylesheet). Reduced motion (the system's, or the app's own
 * `data-motion="off"`): no movement, a still ring for the same time.
 */
export const ADDRESSED_CSS =
  `@keyframes lk-addr-pulse{0%{box-shadow:0 0 0 0 var(--lk-ring);transform:scale(1)}` +
  `35%{box-shadow:0 0 0 3px var(--lk-ring);transform:scale(1.15)}` +
  `100%{box-shadow:0 0 0 5px transparent;transform:scale(1)}}` +
  `[${FLASH_ATTR}]{border-radius:9999px;animation:lk-addr-pulse ${FLASH_MS / 2}ms ease-out 2}` +
  `@media (prefers-reduced-motion: reduce){[${FLASH_ATTR}]{animation:none!important;box-shadow:0 0 0 2px var(--lk-ring)}}` +
  `html[data-motion="off"] [${FLASH_ATTR}]{animation:none!important;box-shadow:0 0 0 2px var(--lk-ring)}`;

/** The props that make an element flash in `lane`'s colour. */
export const flashProps = (lane: LaneId) => ({
  [FLASH_ATTR]: lane,
  style: { "--lk-ring": ringOf(lane) } as Record<string, string>,
});

/** An owner line as the tracker needs it. */
export type OwnerLineLike = { id: string; from?: string; text: string };

/**
 * The once-per-utterance tracker. `heard` takes the live interim text,
 * `lines` the message list; each hands back what to flash now.
 */
export function createAddressFlash() {
  /** The lanes already flashed in the utterance under way. */
  let flashed = new Set<LaneId>();
  let lastHeard = -Infinity;
  /** Owner lines already seen; null until the first non-empty list (the history: never flashed). */
  let seen: Set<string> | null = null;
  /** The last owner line that arrived, and when. */
  let lastLine = { text: "", at: -Infinity };
  const fresh = (lanes: LaneId[]) => {
    const out = lanes.filter((l) => !flashed.has(l));
    for (const l of out) flashed.add(l);
    return out;
  };
  return {
    /** Interim text at `now`: the lanes its name(s) call that have not flashed in this utterance. */
    heard(text: string, now: number): LaneId[] {
      if (now - lastHeard > UTTERANCE_GAP_MS) flashed = new Set();
      if (!text.trim()) return [];
      lastHeard = now;
      return fresh(addressedLanes(text));
    },
    /**
     * The message list at `now`: each owner line that arrived since, with the
     * lanes it calls (its marks pulse once), and `lanes`, the ones to flash
     * in the log that the interim did not already. Each arrival ends the
     * utterance. The first non-empty list is the history: nothing flashes.
     */
    lines(
      messages: readonly OwnerLineLike[],
      now: number,
    ): { arrived: { id: string; lanes: LaneId[] }[]; lanes: LaneId[] } {
      const out = { arrived: [] as { id: string; lanes: LaneId[] }[], lanes: [] as LaneId[] };
      if (!seen) {
        if (!messages.length) return out;
        seen = new Set(messages.filter((m) => m.from === "owner").map((m) => m.id));
        return out;
      }
      for (const m of messages) {
        if (m.from !== "owner" || seen.has(m.id)) continue;
        seen.add(m.id);
        // The same words again at once: the hub's copy of a line shown before it (a new id), not a new call.
        if (m.text === lastLine.text && now - lastLine.at <= UTTERANCE_GAP_MS) continue;
        lastLine = { text: m.text, at: now };
        if (now - lastHeard > UTTERANCE_GAP_MS) flashed = new Set();
        const lanes = addressedLanes(m.text);
        if (lanes.length) out.arrived.push({ id: m.id, lanes });
        for (const l of fresh(lanes)) if (!out.lanes.includes(l)) out.lanes.push(l);
        // The line is sent: the next words are a new utterance.
        flashed = new Set();
        lastHeard = -Infinity;
      }
      return out;
    },
  };
}

/** Each lane's most recent message id in `messages` (its avatar is the one that flashes). */
export function latestOfLane(
  messages: readonly { id: string; lane?: unknown }[],
): Partial<Record<LaneId, string>> {
  const out: Partial<Record<LaneId, string>> = {};
  for (const m of messages) if (typeof m.lane === "string" && m.lane in LANES) out[m.lane as LaneId] = m.id;
  return out;
}
