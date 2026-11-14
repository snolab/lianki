/**
 * The chat's code, as one import both React.lazy (DebugEval.tsx) and the idle
 * prefetch (DebugEvalLazy.tsx, lib/chat-prefetch.ts) use, so the prefetch warms
 * exactly the chunk the chat then renders from.
 */
export const loadChatHost = () => import("@lianki/debug-chat/DebugChatHost");
