/**
 * The debug chat as a module of its own, for hot-loading from a dev server
 * (docs/dev-debug-widget.md). scripts/dev/debug-widget-server.ts builds this
 * file to /debug-chat.js with React taken from the page, and appends `css`
 * (the Tailwind utilities it uses) and `rev`. The page renders DebugChat in
 * its own tree (DebugChatHost.tsx). Never imported by the app.
 */
export { DebugChat } from "./DebugChat";
export { WIDGET_API } from "./debug-widget";
