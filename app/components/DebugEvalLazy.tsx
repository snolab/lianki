"use client";

import dynamic from "next/dynamic";

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
export const DebugEvalLazy = dynamic(() => import("./DebugEval").then((m) => m.DebugEval), {
  ssr: false,
});
