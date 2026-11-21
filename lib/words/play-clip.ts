/**
 * Start a word clip and report its end exactly once. A rejected play()
 * (autoplay refused, nothing decodable) ends the part too — before, it was
 * swallowed, `done` never came and lib/words/sequence.ts stalled the card.
 */
type ClipElement = Pick<HTMLAudioElement, "play"> & {
  onended: ((this: GlobalEventHandlers, ev: Event) => unknown) | null;
  onerror: OnErrorEventHandler;
};

export function playClip(
  el: ClipElement,
  h: {
    done: (played: boolean) => void;
    /** play() refused: what goes on instead (another voice); by default the part ends unplayed. */
    refused?: () => void;
    /** False once the part was cut: nothing is reported then. */
    current: () => boolean;
  },
): void {
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled || !h.current()) return;
    settled = true;
    el.onended = null;
    el.onerror = null;
    fn();
  };
  const refuse = () => settle(() => (h.refused ? h.refused() : h.done(false)));
  el.onended = () => settle(() => h.done(true));
  el.onerror = refuse;
  try {
    void el.play().catch(refuse);
  } catch {
    refuse();
  }
}
