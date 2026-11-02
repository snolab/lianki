/**
 * The chat's side of the islands' action bus (lib/islands/actions.ts,
 * docs/bottom-nav.md): the nav island's partner button sends `chat.open` as
 * the CustomEvent `lk:island-action` on window, `{name, payload}`. The
 * widget imports nothing from the app, so the payload's schema
 * (lib/islands/contract.ts: `{ node?: string ≤ 200 }`) is checked here by
 * hand; a payload that does not fit is dropped, never thrown.
 */
export const ISLAND_ACTION_EVENT = "lk:island-action";
export const CHAT_OPEN_ACTION = "chat.open";

/** The `chat.open` payload in an event's detail, or null when it is not one (or does not fit). */
export function chatOpenFrom(detail: unknown): { node?: string } | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as { name?: unknown; payload?: unknown };
  if (d.name !== CHAT_OPEN_ACTION) return null;
  const p = d.payload ?? {};
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const node = (p as { node?: unknown }).node;
  if (node === undefined) return {};
  return typeof node === "string" && node.length <= 200 ? { node } : null;
}

/** Listen for `chat.open` on `target` (window); returns the unsubscribe. */
export function onChatOpen(
  handler: (payload: { node?: string }) => void,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const listener = (e: Event) => {
    const p = chatOpenFrom((e as CustomEvent).detail);
    if (p) handler(p);
  };
  target.addEventListener(ISLAND_ACTION_EVENT, listener);
  return () => target.removeEventListener(ISLAND_ACTION_EVENT, listener);
}
