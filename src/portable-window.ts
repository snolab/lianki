/**
 * 随身Li's chat window bundled into the userscript (docs/userscript-li-chat.md,
 * "The chat window"): the main site's DebugChat, for sites whose CSP refuses
 * the lianki.com frame. No eval and no remote code.
 *
 * This file is a stand-in. The release build (scripts/build-userscript.ts) and
 * the dev servers replace it through scripts/portable-window-plugin.ts with
 * the Learning Partner build (scripts/build-partner-embed.ts) as ONE plain
 * function: React, the widget and its CSS sit inside its body, so nothing of it
 * runs on page load; it runs only when the chat opens and calls it. A build
 * without the plugin (tests, other tools) keeps this null: the frame only.
 */
export type PortableWindowStore = {
  get(k: string): unknown;
  set(k: string, v: string): void;
  del(k: string): void;
  keys(): string[];
};
export type PortableWindowFactory = (gm: PortableWindowStore | null) => {
  api: { mountPortable?: (o: unknown) => { destroy(): void } };
  css: string[];
  rev: string;
};
const portableWindow: PortableWindowFactory | null = null;
export default portableWindow;
/** The chat's strings per locale (intlayer `learning-partner`), filled with the window. */
export const portableChatStrings: Record<string, Record<string, string>> | null = null;
