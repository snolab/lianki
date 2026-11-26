/**
 * 随身Li's consent prompt styles and the broker call type. The chat window
 * itself is the main site's DebugChat (src/portable-li.ts: the lianki.com
 * frame, else the copy bundled in the userscript); there is no other chat UI.
 */
import type { PageChatHttpInput, PageChatHttpResult } from "../lib/page-chat-http-wire";
export type PortableChatCall = (
  input: PageChatHttpInput,
  principal?: string,
  signal?: AbortSignal,
) => Promise<PageChatHttpResult>;
export const PORTABLE_PANEL_CSS = `
:host{all:initial!important;position:fixed!important;right:12px!important;bottom:80px!important;z-index:2147483644!important;font:14px/1.5 system-ui,sans-serif!important;color-scheme:light dark;--bg:oklch(0.97 0.01 82 / 0.94);--fg:oklch(0.25 0.02 65);--line:oklch(0.25 0.02 65 / 0.15);--soft:oklch(0.25 0.02 65 / 0.06);--seal:oklch(0.53 0.207 22.3);--on-seal:oklch(0.99 0 0)}
@media (prefers-color-scheme:dark){:host{--bg:oklch(0.2 0.01 65 / 0.94);--fg:oklch(0.93 0.01 82);--line:oklch(0.93 0.01 82 / 0.15);--soft:oklch(0.93 0.01 82 / 0.08)}}
*{box-sizing:border-box}section{width:min(360px,calc(100vw - 24px));display:flex;flex-direction:column;border:1px solid var(--line);border-radius:14px;background:var(--bg);color:var(--fg);box-shadow:0 8px 30px oklch(0 0 0 / 0.2);backdrop-filter:blur(12px) saturate(1.4);overflow:hidden}
button{font:inherit;cursor:pointer;min-height:40px;border:0;border-radius:999px;padding:5px 12px;background:var(--soft);color:var(--fg)}button:first-child{background:var(--seal);color:var(--on-seal)}button:focus-visible{outline:2px solid var(--seal);outline-offset:2px}button:disabled{opacity:.6;cursor:default}
`;
export function attachPortableStyle(root: ShadowRoot, doc: Document, css: string) {
  // Constructed sheets are local static CSS, so strict style-src does not require remote CSS or policy edits.
  const Sheet = doc.defaultView?.CSSStyleSheet;
  if (Sheet && "adoptedStyleSheets" in root) {
    const sheet = new Sheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } else {
    const style = doc.createElement("style");
    style.textContent = css;
    root.append(style);
  }
}
