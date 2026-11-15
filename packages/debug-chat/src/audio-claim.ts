/**
 * Who may make a sound on the page: one owner at a time, by priority
 * (owner, 2026-11-05 03:05–03:06 JST). Li's voice-out (voice.ts) outranks
 * a word or card read aloud (/words, the reader's word review), which
 * outranks the reader's paragraph read-aloud (lib/read/speaker.ts). A
 * higher claim pauses the one playing; when it is released, the paused one
 * resumes where it was (the reader: the same sentence).
 *
 * The contract is two window events, not shared module state, so the
 * hot-loaded widget bundle and the app bundle agree whatever copy of this
 * file each carries (docs/dev-debug-widget.md, "Page audio owner"):
 *
 * - `lk:audio-claim`, cancelable, detail `{ id, prio }`: "I am about to
 *   play". An owner holding or waiting with a HIGHER prio cancels it (the
 *   claimer waits); one holding with an equal or lower prio pauses (yields)
 *   and waits — the newest of equals wins.
 * - `lk:audio-release`, detail `{ id }`: "I am done". Everyone waiting tries
 *   its claim again; a higher waiter cancels a lower one's retry, so the
 *   highest resumes first. Event-driven: nothing polls.
 */

export const AUDIO_CLAIM = "lk:audio-claim";
export const AUDIO_RELEASE = "lk:audio-release";
/** Higher wins. */
/** `play`: an agent's audio on a chat line (li-player.ts), ranked with a card read aloud. */
export const AUDIO_PRIO = { li: 3, card: 2, play: 2, para: 1 } as const;

export type AudioClaimDetail = { id: string; prio: number };
export type AudioOwnerState = "idle" | "holding" | "waiting";
export type AudioOwner = {
  /** True: play now. False: wait — `onResume` says when. */
  claim(): boolean;
  /** Done (or no longer wants to play). Waiters retry. */
  release(): void;
  state(): AudioOwnerState;
  /** The same as release (an idle owner listens to nothing). */
  dispose(): void;
};
export type AudioOwnerOpts = {
  id: string;
  prio: number;
  /** A higher (or newer equal) claim took the page: stop the sound now, keep the place. */
  onYield?(): void;
  /** The page is ours again after waiting: go on from the place. */
  onResume?(): void;
  /** The page's window (absent: globalThis, if it can dispatch). */
  target?: EventTarget | null;
};

const pageTarget = (): EventTarget | null => {
  const g = globalThis as unknown as Partial<EventTarget>;
  return typeof g.addEventListener === "function" && typeof g.dispatchEvent === "function"
    ? (g as EventTarget)
    : null;
};

let seq = 0;
/** An id unique on this page for `kind` (two bundles: the random part keeps them apart). */
export const audioOwnerId = (kind: string) =>
  `${kind}:${++seq}:${Math.random().toString(36).slice(2, 8)}`;

export function audioOwner(o: AudioOwnerOpts): AudioOwner {
  const t = o.target === undefined ? pageTarget() : o.target;
  let state: AudioOwnerState = "idle";
  const detail = (): AudioClaimDetail => ({ id: o.id, prio: o.prio });
  /** Dispatch a claim; true when nobody cancelled it. */
  const ask = () => {
    if (!t) return true;
    const e = new CustomEvent(AUDIO_CLAIM, { detail: detail(), cancelable: true });
    t.dispatchEvent(e);
    return !e.defaultPrevented;
  };
  const onClaim = (ev: Event) => {
    const d = (ev as CustomEvent<AudioClaimDetail>).detail;
    if (!d || d.id === o.id || state === "idle") return;
    if (o.prio > d.prio) return ev.preventDefault();
    if (state === "holding") {
      state = "waiting";
      o.onYield?.();
    }
  };
  const onRelease = (ev: Event) => {
    const d = (ev as CustomEvent<{ id: string }>).detail;
    if (d?.id === o.id || state !== "waiting") return;
    if (!ask()) return;
    state = "holding";
    o.onResume?.();
  };
  // Listening only while it holds or waits: an idle owner (a speaker made
  // once per page, a sequencer kept in a memo) needs no cleanup.
  let on = false;
  const listen = (yes: boolean) => {
    if (!t || on === yes) return;
    on = yes;
    if (yes) {
      t.addEventListener(AUDIO_CLAIM, onClaim);
      t.addEventListener(AUDIO_RELEASE, onRelease);
    } else {
      t.removeEventListener(AUDIO_CLAIM, onClaim);
      t.removeEventListener(AUDIO_RELEASE, onRelease);
    }
  };
  const release = () => {
    const was = state;
    state = "idle";
    listen(false);
    // Only a holder frees the page; a waiter leaving changes nothing for the others.
    if (was === "holding" && t)
      t.dispatchEvent(new CustomEvent(AUDIO_RELEASE, { detail: { id: o.id } }));
  };
  return {
    claim() {
      if (state === "holding") return true;
      state = ask() ? "holding" : "waiting";
      listen(true);
      return state === "holding";
    },
    release,
    state: () => state,
    dispose: release,
  };
}
