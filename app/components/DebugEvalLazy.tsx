"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import type { DebugEval } from "./DebugEval";
import { debugOn } from "@/lib/debug-client";
import { loadChatHost } from "@/lib/chat-host-loader";
import { chatPrefetchWanted, prefetchWhenIdle } from "@/lib/chat-prefetch";

/**
 * DebugEval (the chat, remote eval, pairing, hot islands) in the browser only.
 *
 * Its first render is always empty — the socket, the chat and the toast all
 * start in effects — so rendering it on the server produced nothing, yet every
 * page's server render evaluated its whole module graph (the chat's voice, mic
 * and 16-locale string tables): a large part of a cold isolate's first render
 * (docs/cold-start.md, "Server render on a cold isolate"). In the browser it
 * now loads right after hydration instead of before it.
 */
const DebugEvalClient = dynamic(() => import("./DebugEval").then((m) => m.DebugEval), {
  ssr: false,
});

/**
 * DebugEval, and the chat's own chunk prefetched in idle time right after
 * hydration — alongside DebugEval's, not after it — for a signed-in viewer
 * whose chat is wanted; never a guest (docs/cold-start.md, "The chat at once").
 */
export function DebugEvalLazy(props: NonNullable<Parameters<typeof DebugEval>[0]>) {
  const { account = null, partnerOpen = false } = props;
  useEffect(() => {
    if (!chatPrefetchWanted({ account, partnerOpen, debug: debugOn() })) return;
    return prefetchWhenIdle(loadChatHost, window);
    // Once per page: the gate as the page was rendered.
  }, []);
  return <DebugEvalClient {...props} />;
}
