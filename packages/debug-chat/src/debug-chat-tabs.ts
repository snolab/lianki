/**
 * One voice per device: every tab of a thread gets each agent reply, but only
 * one reads it aloud — a tab with the mic on (hands-free; the latest to turn
 * it on), else the focused tab, else the one focused most recently.
 * Tabs tell each other over a BroadcastChannel ("lk-debug-chat"), never the
 * network. docs/monitoring.md, "Chat with the agent".
 */

export const TABS_CHANNEL = "lk-debug-chat";

/** Tab id → when it was last focused (0 = never). */
export type FocusTable = Map<string, number>;

/** The tab that speaks: latest focus wins, ties go to the smaller id. */
export function speakerTab(tabs: FocusTable): string | undefined {
  let best: [string, number] | undefined;
  for (const [id, at] of tabs)
    if (!best || at > best[1] || (at === best[1] && id < best[0])) best = [id, at];
  return best?.[0];
}

type Msg =
  | { type: "focus" | "hello" | "bye"; tab: string; at: number }
  | { type: "mic"; tab: string; at: number; on: boolean };

/**
 * Join the tabs on this device. `isSpeaker()` says whether this tab should
 * read replies aloud right now. Without BroadcastChannel every tab speaks.
 */
export function joinTabs(
  self: string,
  chan: Pick<BroadcastChannel, "postMessage" | "close"> & {
    onmessage: ((e: MessageEvent) => void) | null;
  },
  focused: () => boolean,
  now: () => number = Date.now,
) {
  const tabs: FocusTable = new Map([[self, focused() ? now() : 0]]);
  /** Tabs with the mic on → when they turned it on. */
  const mics: FocusTable = new Map();
  const post = (type: "focus" | "hello" | "bye") =>
    chan.postMessage({ type, tab: self, at: tabs.get(self) ?? 0 } satisfies Msg);
  const postMic = () => {
    const at = mics.get(self);
    chan.postMessage({ type: "mic", tab: self, at: at ?? 0, on: at !== undefined } satisfies Msg);
  };
  chan.onmessage = (e) => {
    const m = e.data as Msg;
    if (!m || typeof m.tab !== "string" || m.tab === self) return;
    if (m.type === "bye") {
      tabs.delete(m.tab);
      mics.delete(m.tab);
      return;
    }
    if (m.type === "mic") {
      if (m.on) mics.set(m.tab, Number(m.at) || 0);
      else mics.delete(m.tab);
      return;
    }
    tabs.set(m.tab, Number(m.at) || 0);
    // A newcomer asks who is here: answer with this tab's focus time (and mic).
    if (m.type === "hello") {
      post("focus");
      if (mics.has(self)) postMic();
    }
  };
  post("hello");
  return {
    /** This tab just gained focus (or became visible). */
    focus() {
      tabs.set(self, now());
      post("focus");
    },
    /** This tab's mic turned on or off: while on, this tab reads replies aloud. */
    mic(on: boolean) {
      if (on === mics.has(self)) return;
      if (on) mics.set(self, now());
      else mics.delete(self);
      postMic();
    },
    isSpeaker: () =>
      mics.size ? speakerTab(mics) === self : focused() || speakerTab(tabs) === self,
    leave() {
      post("bye");
      chan.close();
    },
  };
}
