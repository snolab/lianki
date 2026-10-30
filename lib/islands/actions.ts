/**
 * The islands' action bus (docs/dev-hot-islands.md): one-off commands like
 * undo, refresh or "open the settings sheet", as the CustomEvent
 * `lk:island-action` on window, `{name, payload}`. Every action and its
 * payload's zod schema are listed in contract.ts (ACTIONS).
 *
 * Sending parses the payload (a bad send throws at the sender). Receiving
 * safeParses it: a payload from an island built on another contract version
 * that no longer fits is dropped and logged, never thrown into the receiver.
 * No module state, so a remote island's own copy talks to the page's.
 */
import { useEffect, useRef } from "react";
import { devLog } from "@/lib/debug-client";
import { ACTIONS, type ActionName, type ActionPayload } from "./contract";

export const ACTION_EVENT = "lk:island-action";

type Detail = { name?: unknown; payload?: unknown };

/** Send an action to every island on this page. */
export function sendAction<A extends ActionName>(name: A, payload: ActionPayload<A>) {
  const data = ACTIONS[name].parse(payload);
  window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: { name, payload: data } }));
}

/** Call `handler` for each `name` action with a payload that fits. Returns the unsubscribe. */
export function onAction<A extends ActionName>(
  name: A,
  handler: (payload: ActionPayload<A>) => void,
  log: (event: Record<string, unknown>) => void = devLog,
): () => void {
  const listener = (e: Event) => {
    const d = (e as CustomEvent<Detail>).detail;
    if (!d || d.name !== name) return;
    const r = ACTIONS[name].safeParse(d.payload);
    if (!r.success) {
      log({ ev: "island-action-dropped", name, why: r.error.message.slice(0, 200) });
      return;
    }
    handler(r.data as ActionPayload<A>);
  };
  window.addEventListener(ACTION_EVENT, listener);
  return () => window.removeEventListener(ACTION_EVENT, listener);
}

/** The effect behind useIslandAction: listen, always calling the latest handler in `ref`. */
export const listenLatest =
  <A extends ActionName>(name: A, ref: { current: (payload: ActionPayload<A>) => void }) =>
  () =>
    onAction(name, (p) => ref.current(p));

/** onAction for the life of a component; the latest `handler` always runs. */
export function useIslandAction<A extends ActionName>(
  name: A,
  handler: (payload: ActionPayload<A>) => void,
) {
  const ref = useRef(handler);
  ref.current = handler;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- ref is stable
  useEffect(listenLatest(name, ref), [name]);
}
