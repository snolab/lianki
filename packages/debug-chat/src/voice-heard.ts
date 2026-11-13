/**
 * Which voice actually read each line (owner, 2026-11-14 01:10 JST: agy's
 * lines rotate through the Mac-local Kokoro neko voices and he could not tell
 * which one he heard). Kept in memory only, per line id and sentence: the
 * message details popup (MessageDetails.tsx) shows it, and "Use this voice"
 * pins a rotated Kokoro voice on this device.
 *
 * The pin (`lk:agent-local-tts-voice`) is a **device** setting
 * (docs/prefs-sync.md): the local engine is a tailnet URL on his Mac, like
 * `lk:agent-local-tts` beside it. Absent = rotate.
 *
 * One store per page (globalThis), so a hot-swapped copy of the voice
 * session and the chat share it.
 */
import { LOCAL_ENGINES } from "./voices";

/** The voice a sentence was read in. `cycle`: picked for `local:neko-cycle` (rotation or pin). */
export type HeardVoice = { name: string; cycle?: boolean };

export const LOCAL_VOICE_PIN_KEY = "lk:agent-local-tts-voice";
/**
 * The Kokoro voices `local:neko-cycle` takes turns through, one per clip. One
 * voice now (owner, 2026-11-14 02:0x JST: "不要轮换了，你就固定一个可爱的宝宝音");
 * a pin still replaces it on a device.
 */
export const NEKO_ROTATION = ["baby"] as const;
/** Lines remembered (oldest dropped first). */
export const HEARD_LINES = 200;

type Store = {
  lines: Map<string, Map<string, HeardVoice>>;
  subs: Set<() => void>;
  ver: number;
};
const store = (): Store => {
  const g = globalThis as { __lkVoiceHeard?: Store };
  return (g.__lkVoiceHeard ??= { lines: new Map(), subs: new Set(), ver: 0 });
};
const changed = () => {
  const s = store();
  s.ver++;
  for (const f of s.subs) f();
};

/** Note the voice that read one sentence of a line (a later read of it replaces the earlier). */
export function noteHeard(lineId: string | undefined, sentence: string, v: HeardVoice) {
  if (!lineId || !v.name) return;
  const { lines } = store();
  let line = lines.get(lineId);
  if (!line) {
    line = new Map();
    lines.set(lineId, line);
    while (lines.size > HEARD_LINES) lines.delete(lines.keys().next().value as string);
  }
  const had = line.get(sentence);
  if (had && had.name === v.name && !!had.cycle === !!v.cycle) return;
  line.set(sentence, v.cycle ? { name: v.name, cycle: true } : { name: v.name });
  changed();
}

/** The distinct voices that read a line, in the order first heard. */
export function heardFor(lineId: string | undefined): HeardVoice[] {
  const line = lineId ? store().lines.get(lineId) : undefined;
  if (!line) return [];
  const out = new Map<string, HeardVoice>();
  for (const v of line.values()) {
    const had = out.get(v.name);
    if (!had) out.set(v.name, v);
    else if (v.cycle && !had.cycle) out.set(v.name, v);
  }
  return [...out.values()];
}

/** For useSyncExternalStore: notes and pin changes. */
export const subscribeHeard = (f: () => void) => {
  const { subs } = store();
  subs.add(f);
  return () => void subs.delete(f);
};
export const heardVersion = () => store().ver;

/** Forget every line (tests). */
export function clearHeard() {
  store().lines.clear();
  changed();
}

const isLocal = (name: string | null | undefined): name is string =>
  !!name && (LOCAL_ENGINES as readonly string[]).includes(name);

/** The Kokoro voice pinned on this device for `neko-cycle` (null: rotate). */
export function pinnedLocalVoice(): string | null {
  try {
    const v = localStorage.getItem(LOCAL_VOICE_PIN_KEY);
    return isLocal(v) ? v : null;
  } catch {
    return null;
  }
}

/** Pin a Kokoro voice for `neko-cycle` on this device; null unpins (rotate again). */
export function pinLocalVoice(name: string | null) {
  try {
    if (isLocal(name)) localStorage.setItem(LOCAL_VOICE_PIN_KEY, name);
    else localStorage.removeItem(LOCAL_VOICE_PIN_KEY);
  } catch {
    // storage blocked: the rotation stays
  }
  changed();
}

/**
 * The concrete Kokoro voice for a `local:` name: `neko-cycle` is the pinned
 * voice when there is one, else the rotation's turn; any other name is itself.
 */
export function pickLocalVoice(voice: string, turn: number, pinned: string | null): HeardVoice {
  if (voice !== "neko-cycle") return { name: voice };
  if (isLocal(pinned)) return { name: pinned, cycle: true };
  return { name: NEKO_ROTATION[turn % NEKO_ROTATION.length]!, cycle: true };
}
