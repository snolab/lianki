/** Tail-follow intent survives history batches and passive content growth. No clocks or polling. */
export type FollowBox = { scrollTop: number; scrollHeight: number; clientHeight: number };
type Ref<T> = { current: T };
export function createScrollFollow(d: {
  box: () => FollowBox | null;
  following: Ref<boolean>;
  pinned: Ref<number | null>;
}) {
  let geometry: { height: number; viewport: number } | null = null;
  let interruptedAt: number | null = null;
  const remember = (box: FollowBox) => {
    geometry = { height: box.scrollHeight, viewport: box.clientHeight };
  };
  return {
    /** Explicit upward wheel/touch/key/scrollbar intent wins before a queued resize or history frame. */
    away() {
      interruptedAt = d.box()?.scrollTop ?? null;
      d.following.current = false;
      d.pinned.current = null;
    },
    reset() {
      geometry = null;
      interruptedAt = null;
      d.following.current = true;
      d.pinned.current = null;
    },
    /** Only callers representing an explicit return to newest may force a pin. */
    pin(force = false) {
      const box = d.box();
      if (!box || (!force && !d.following.current)) return false;
      interruptedAt = null;
      if (force) d.following.current = true;
      box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
      d.pinned.current = box.scrollTop; // Read browser clamping rather than the requested scrollHeight.
      remember(box);
      return true;
    },
    scroll() {
      const box = d.box();
      if (!box) return d.following.current;
      const moved = interruptedAt === null || Math.abs(box.scrollTop - interruptedAt) > 1;
      const grew =
        !geometry || geometry.height !== box.scrollHeight || geometry.viewport !== box.clientHeight;
      const own = d.pinned.current !== null && Math.abs(box.scrollTop - d.pinned.current) <= 1;
      const near = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
      // A delayed programmatic event at the old bottom must not cancel a just-started user gesture.
      const following =
        interruptedAt !== null && !moved ? false : near || (d.following.current && (own || grew));
      if (interruptedAt !== null && moved) interruptedAt = null;
      d.following.current = following;
      if (!following) d.pinned.current = null;
      remember(box);
      return following;
    },
  };
}
