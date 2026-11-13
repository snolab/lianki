/**
 * The Learning Partner is always findable (owner, 2026-11-14 ~01:00 JST;
 * docs/dev-debug-widget.md, "Always findable"). Pure rules, shared by the root
 * layout (server), the chat (app/components/DebugEval.tsx) and the sidebar's
 * "Learning Partner" row (lib/nav/islands/NavRows.tsx).
 *
 * - `partner`: `partner.ai-reply` is on and the viewer is signed in without
 *   the `dev` grant: the chat is on every page, whatever debug mode says.
 * - `member`: signed in, but the chat is only on in debug mode (the flag off,
 *   or a `dev` holder, whose debug mode is a developer switch).
 * - `null`: a guest. No chat, no row.
 */
import { type FlagValues, flagIn } from "@/lib/flags";

export type ChatViewer = "partner" | "member" | null;

/** `<html data-chat-viewer>`: the server's answer, read by the nav islands (no prop, no contract bump). */
export const CHAT_VIEWER_ATTR = "data-chat-viewer";

/** Who this page's viewer is to the chat, from the flags, the session and the `dev` grant. */
export function chatViewerOf(
  flags: FlagValues | null | undefined,
  signedIn: boolean,
  dev: boolean,
): ChatViewer {
  if (!signedIn) return null;
  return flagIn(flags, "partner.ai-reply") && !dev ? "partner" : "member";
}

/**
 * The chat is wanted on this page: debug mode, or the Learning Partner opened
 * to this user. Turning debug mode off (the hidden 7/10-tap toggles) never
 * takes a partner user's chat away: it can fold, never disappear.
 */
export function chatWanted(debug: boolean, partnerOpen: boolean): boolean {
  return debug || partnerOpen;
}

/** The sidebar's (and the phone drawer's) "Learning Partner" row: wherever the chat is. */
export function partnerEntryShown(viewer: ChatViewer, debug: boolean): boolean {
  if (viewer === null) return false;
  return chatWanted(debug, viewer === "partner");
}

/** The attribute's value as read back in the browser (anything else: a guest). */
export function readChatViewer(value: string | null | undefined): ChatViewer {
  return value === "partner" || value === "member" ? value : null;
}
