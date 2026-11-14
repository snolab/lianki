"use client";

import { useEffect, useState } from "react";
import type { ChatMessage } from "@/lib/dev-eval";
import { chatCacheFrozen, clearChatCache, readChatCache, writeChatCache } from "@/lib/chat-cache";

/** The device's copy is written this long after the lines last changed. */
export const CACHE_WRITE_MS = 300;

/**
 * The chat's lines as DebugEval shows them, and the device's copy of them
 * (lib/chat-cache.ts): read in the first render so the chat paints at once,
 * replaced by the hub's history (`fromHub`), and written back, debounced,
 * once the hub's lines are in.
 *
 * The page's identity can change under one mounted instance: the root
 * layout's session refresh renders it for another account (A → B), or for
 * no one (A → null, the session expired). Then A's lines must neither stay on
 * B's page nor be written under B's key by the pending timer. The reset is
 * the "adjust state on a prop change" form: it happens in the render that
 * first sees the new account, and React re-renders before committing, so no
 * effect ever runs with A's lines and B's account.
 */
export function useChatCache({
  account,
  box,
  cacheLines,
  wanted,
}: {
  /** The signed-in account's id as the server rendered the page (null: a guest). */
  account: string | null;
  /** On a box the chat talks to lianki.com's hub: never a device copy there. */
  box: boolean;
  /** Config `chat.cacheLines`: lines kept on the device; 0 = none. */
  cacheLines: number;
  /** The chat is wanted on this page (debug mode, or the Learning Partner open). */
  wanted: boolean;
}) {
  const fresh = () => (!box && cacheLines > 0 && wanted ? readChatCache(account) : []);
  const [cachedLines, setCachedLines] = useState<ChatMessage[]>(fresh);
  const [messages, setMessages] = useState<ChatMessage[]>(cachedLines);
  /** The hub's history has arrived: the lines are the hub's, no longer the device's copy. */
  const [fromHub, setFromHub] = useState(false);
  const [seenAccount, setSeenAccount] = useState(account);
  if (seenAccount !== account) {
    // Another account (or none) under this instance: start over for it. A read
    // for the new account drops the old account's entry on its own.
    setSeenAccount(account);
    const next = fresh();
    setCachedLines(next);
    setMessages(next);
    setFromHub(false);
  }
  // No session on this page (signed out, expired): no chat lines stay on the device.
  useEffect(() => {
    if (!account && !box) clearChatCache();
  }, [account, box]);
  // Keep the newest lines of this account's thread on the device, once the hub's
  // are in. Never once sign-out began (the write would be refused anyway).
  useEffect(() => {
    if (!fromHub || box || !account || chatCacheFrozen()) return;
    const t = setTimeout(() => writeChatCache(account, messages, cacheLines), CACHE_WRITE_MS);
    return () => clearTimeout(t);
  }, [messages, fromHub, account, cacheLines, box]);
  return { cachedLines, messages, setMessages, fromHub, setFromHub };
}
