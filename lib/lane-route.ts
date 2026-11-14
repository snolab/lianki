/**
 * Which lane answers an owner line: the matcher lives in the chat widget's
 * package (packages/debug-chat/src/lane-route.ts), so the chat can flash the
 * addressed lane's avatar with the very rule the listeners route by. This
 * re-export keeps the scripts' and the docs' path.
 */
export * from "@lianki/debug-chat/lane-route";
