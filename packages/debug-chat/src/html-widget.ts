/**
 * HTML message widgets (owner, 2026-11-25: "用 html 做组件，json 的组件自由度太低了").
 * An agent line in his own thread (rich-text.ts widgetLine) may carry
 *
 *   ```lianki-html
 *   <button onclick="lianki.reply('A')">A</button>
 *   ```
 *
 * and the chat runs it in a sandboxed iframe (HtmlWidget.tsx):
 *   - `srcdoc`, `sandbox="allow-scripts allow-forms"`, never allow-same-origin:
 *     an opaque origin, so no cookies, storage, page DOM or same-origin API.
 *   - No allow-top-navigation, allow-popups or allow-modals: it cannot move the
 *     page, open a window or block it with a dialog.
 *   - A CSP inside the document: no network at all (connect, img, font, frame
 *     and form-action are 'none' or data:), inline script and style only.
 *   - A form never navigates: the bootstrap below catches every submit, keeps
 *     the page where it is, and hands its fields to the chat by postMessage, the
 *     way a React form action is a function rather than a URL. Nothing is sent
 *     anywhere with his session.
 * What reaches the chat: {lk:"height", h}, {lk:"reply", text} (fills his reply
 * box; he still sends it), {lk:"action", name, fields} (shown in his reply box
 * as "name: k=v, …" for now). The chat accepts a message only from its own
 * frame (event.source).
 */

export const HTML_WIDGET_LANG = "lianki-html";
export const MAX_HTML = 50_000;

/** The iframe's sandbox: scripts and forms in an opaque origin, nothing else. */
export const HTML_SANDBOX = "allow-scripts allow-forms";

/** The document's own policy: no network, no frames, no form target, inline only. */
export const HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Runs first in the frame: the `lianki` object, height reports, forms as actions. */
const BOOT = `(()=>{const P=(m)=>parent.postMessage(Object.assign({lk:""},m),"*");
const S=(v,n)=>String(v==null?"":v).slice(0,n);
window.lianki={reply:(t)=>P({lk:"reply",text:S(t,2000)}),action:(name,fields)=>P({lk:"action",name:S(name,80),fields:fields&&typeof fields==="object"?Object.fromEntries(Object.entries(fields).slice(0,20).map(([k,v])=>[S(k,40),S(v,500)])):{}})};
document.addEventListener("submit",(e)=>{e.preventDefault();const f=e.target;const d={};try{new FormData(f,e.submitter).forEach((v,k)=>{d[k]=typeof v==="string"?v:""})}catch(_){};lianki.action(f.getAttribute("name")||f.getAttribute("action")||"submit",d)},true);
document.addEventListener("click",(e)=>{const a=e.target&&e.target.closest&&e.target.closest("a[href]");if(a){e.preventDefault()}},true);
const H=()=>P({lk:"height",h:Math.ceil(document.documentElement.scrollHeight)});
addEventListener("load",H);new ResizeObserver(H).observe(document.documentElement);})();`;

/** The frame's whole document: policy, base look, bootstrap, then the agent's HTML. */
export function htmlWidgetDoc(html: string, dark: boolean): string {
  const body = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>:root{color-scheme:${dark ? "dark" : "light"}}html,body{margin:0;background:transparent;` +
    `font:14px/1.4 system-ui,sans-serif}body{padding:2px}</style>` +
    `<script>${BOOT}</script></head><body>${body}</body></html>`
  );
}

export type HtmlWidgetEvent =
  | { lk: "height"; h: number }
  | { lk: "reply"; text: string }
  | { lk: "action"; name: string; fields: Record<string, string> };

/** A message from the frame, checked: anything else is dropped. */
export function htmlWidgetEvent(data: unknown): HtmlWidgetEvent | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.lk === "height" && typeof d.h === "number" && Number.isFinite(d.h) && d.h >= 0)
    return { lk: "height", h: d.h };
  if (d.lk === "reply" && typeof d.text === "string" && d.text.trim())
    return { lk: "reply", text: d.text.slice(0, 2000) };
  if (d.lk === "action" && typeof d.name === "string") {
    const fields: Record<string, string> = {};
    if (d.fields && typeof d.fields === "object")
      for (const [k, v] of Object.entries(d.fields as Record<string, unknown>).slice(0, 20))
        if (typeof v === "string") fields[k.slice(0, 40)] = v.slice(0, 500);
    return { lk: "action", name: d.name.slice(0, 80) || "submit", fields };
  }
  return null;
}

/** What an action puts in his reply box, until agents get actions as events. */
export const actionReply = (e: Extract<HtmlWidgetEvent, { lk: "action" }>): string => {
  const kv = Object.entries(e.fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return kv ? `${e.name}: ${kv}` : e.name;
};
