/**
 * One voice per device: every tab of a thread gets each agent reply, but only
 * one reads it aloud — the focused tab, else the one focused most recently.
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

type Msg = { type: "focus" | "hello" | "bye"; tab: string; at: number };

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
  const post = (type: Msg["type"]) =>
    chan.postMessage({ type, tab: self, at: tabs.get(self) ?? 0 } satisfies Msg);
  chan.onmessage = (e) => {
    const m = e.data as Msg;
    if (!m || typeof m.tab !== "string" || m.tab === self) return;
    if (m.type === "bye") return void tabs.delete(m.tab);
    tabs.set(m.tab, Number(m.at) || 0);
    // A newcomer asks who is here: answer with this tab's focus time.
    if (m.type === "hello") post("focus");
  };
  post("hello");
  return {
    /** This tab just gained focus (or became visible). */
    focus() {
      tabs.set(self, now());
      post("focus");
    },
    isSpeaker: () => focused() || speakerTab(tabs) === self,
    leave() {
      post("bye");
      chan.close();
    },
  };
}
