import { uuidv4 } from "../packages/debug-chat/src/uuid";
/** Statically bundled, text-only chat UI. No iframe, remote JS, HTML rendering or page-content capture. */
import type { ChatMessage } from "../packages/debug-chat/src/wire";
import type { PageChatHttpInput, PageChatHttpResult } from "../lib/page-chat-http-wire";
import { portableChatPath } from "../lib/portable-chat-url";
import type { PortableLiStrings } from "./portable-li-strings";
import type { PillChatStrings } from "./pill-chat-strings";
export type PortableChatCall = (
  input: PageChatHttpInput,
  principal?: string,
  signal?: AbortSignal,
) => Promise<PageChatHttpResult>;
export const PORTABLE_PANEL_CSS = `
:host{all:initial!important;position:fixed!important;right:12px!important;bottom:80px!important;z-index:2147483644!important;font:14px/1.5 system-ui,sans-serif!important;color-scheme:light dark;--bg:oklch(0.97 0.01 82 / 0.94);--fg:oklch(0.25 0.02 65);--line:oklch(0.25 0.02 65 / 0.15);--soft:oklch(0.25 0.02 65 / 0.06);--seal:oklch(0.53 0.207 22.3);--on-seal:oklch(0.99 0 0)}
@media (prefers-color-scheme:dark){:host{--bg:oklch(0.2 0.01 65 / 0.94);--fg:oklch(0.93 0.01 82);--line:oklch(0.93 0.01 82 / 0.15);--soft:oklch(0.93 0.01 82 / 0.08)}}
*{box-sizing:border-box}section{width:min(360px,calc(100vw - 24px));max-height:min(560px,calc(100dvh - 92px));display:flex;flex-direction:column;border:1px solid var(--line);border-radius:14px;background:var(--bg);color:var(--fg);box-shadow:0 8px 30px oklch(0 0 0 / 0.2);backdrop-filter:blur(12px) saturate(1.4);overflow:hidden}
header{display:flex;align-items:center;gap:8px;padding:8px 10px}header strong{flex:1;min-width:0;overflow-wrap:anywhere}button,a,textarea{font:inherit}button{cursor:pointer;min-height:40px;border:0;border-radius:999px;padding:5px 12px;background:var(--soft);color:var(--fg)}button[type=submit]{background:var(--seal);color:var(--on-seal)}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid var(--seal);outline-offset:2px}button:disabled{opacity:.6;cursor:default}
main{overflow:auto;min-height:80px;max-height:340px;padding:8px 10px;overscroll-behavior:contain}.line{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:8px 10px;border-radius:12px;background:var(--soft)}.line[data-from=agent]{background:transparent;padding-inline:0}.note{font-size:12px;padding:0 10px 8px;overflow-wrap:anywhere}.note a{color:var(--seal)}form{display:flex;gap:6px;padding:8px}textarea{resize:none;min-height:40px;max-height:120px;flex:1;min-width:0;border:1px solid var(--line);border-radius:12px;padding:8px 10px;background:transparent;color:var(--fg)}[hidden]{display:none!important}.status{padding:0 10px;font-size:12px}.actions{display:flex;gap:6px;flex-wrap:wrap;padding:0 10px 8px}
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
export function portableLiPanel(d: {
  doc: Document;
  origin: string;
  hostOrigin: string;
  principal: string;
  call: PortableChatCall;
  strings: PortableLiStrings;
  common: PillChatStrings;
  locale?: string;
  collapsed: boolean;
  onCollapse(value: boolean): void;
  onExclude(): void;
  onInvalidAccount(): void;
}) {
  const { doc, strings: t } = d;
  const host = doc.createElement("lianki-portable-chat");
  const root = host.attachShadow({ mode: "closed" });
  attachPortableStyle(root, doc, PORTABLE_PANEL_CSS);
  const section = doc.createElement("section");
  section.setAttribute("aria-label", t.title);
  section.dir = ["ar", "ur"].includes(d.locale ?? "") ? "rtl" : "ltr";
  const header = doc.createElement("header"),
    title = doc.createElement("strong");
  title.textContent = t.title;
  const toggle = doc.createElement("button");
  toggle.type = "button";
  const main = doc.createElement("main");
  main.setAttribute("role", "log");
  main.setAttribute("aria-live", "polite");
  let note: HTMLDivElement | undefined;
  const status = doc.createElement("div");
  status.className = "status";
  status.setAttribute("role", "status");
  const actions = doc.createElement("div");
  actions.className = "actions";
  const retry = doc.createElement("button");
  retry.type = "button";
  retry.textContent = t.retry;
  retry.hidden = true;
  const exclude = doc.createElement("button");
  exclude.type = "button";
  exclude.textContent = t.excludeHere;
  const form = doc.createElement("form"),
    input = doc.createElement("textarea"),
    send = doc.createElement("button");
  input.maxLength = 4000;
  input.rows = 2;
  input.setAttribute("aria-label", d.common.openChat);
  send.type = "submit";
  send.textContent = t.send;
  header.append(title, toggle);
  actions.append(retry, exclude);
  form.append(input, send);
  section.append(header, main, status, actions, form);
  root.append(section);
  (doc.documentElement ?? doc.body).append(host);
  let destroyed = false,
    collapsed = d.collapsed,
    controller: AbortController | undefined,
    afterSeq: number | undefined,
    sending = false;
  let draft: { text: string; id: string } | undefined;
  let awaitingReplySeq: number | undefined;
  const messages = new Map<string, ChatMessage>();
  const render = () => {
    const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 40;
    main.replaceChildren();
    for (const m of [...messages.values()]
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .slice(-200)) {
      const line = doc.createElement("div");
      line.className = "line";
      line.dataset.from = m.from;
      line.textContent = m.text;
      main.append(line);
    }
    if (atBottom) main.scrollTop = main.scrollHeight;
  };
  const fail = (error: string) => {
    if (error === "cancelled" || destroyed) return;
    status.textContent = t.failed;
    retry.hidden = false;
    if (error === "account-changed" || error === "signed-out" || error === "off") {
      stop();
      d.onInvalidAccount();
    }
  };
  const stop = () => {
    controller?.abort();
    controller = undefined;
  };
  const read = async (signal: AbortSignal) => {
    while (!signal.aborted && !destroyed && !collapsed && doc.visibilityState !== "hidden") {
      try {
        const r = await d.call(
          {
            op: "read",
            ...(afterSeq === undefined ? {} : { afterSeq }),
            wait: afterSeq !== undefined,
          },
          d.principal,
          signal,
        );
        if (signal.aborted || destroyed) return;
        if (!r.ok) {
          fail(r.error);
          return;
        }
        if (r.kind !== "history") {
          fail("unavailable");
          return;
        }
        for (const [id, m] of messages)
          if ((m.seq ?? 0) <= r.range.prunedThroughSeq) messages.delete(id);
        for (const m of r.range.messages) messages.set(m.id, m);
        for (const m of r.range.removed) messages.delete(m.id);
        if (messages.size > 200)
          for (const m of [...messages.values()]
            .sort((a, b) => a.at - b.at)
            .slice(0, messages.size - 200))
            messages.delete(m.id);
        afterSeq = r.range.throughSeq;
        render();
        if (
          awaitingReplySeq !== undefined &&
          [...messages.values()].some((m) => m.from === "agent" && (m.seq ?? 0) > awaitingReplySeq!)
        )
          awaitingReplySeq = undefined;
        if (awaitingReplySeq !== undefined && !r.pending) {
          awaitingReplySeq = undefined;
          fail("unavailable");
        } else status.textContent = r.pending ? t.connecting : "";
      } catch {
        if (!signal.aborted) fail("unavailable");
        return;
      }
    }
  };
  const start = () => {
    if (destroyed || collapsed || controller || doc.visibilityState === "hidden") return;
    retry.hidden = true;
    status.textContent = t.connecting;
    controller = new AbortController();
    const current = controller;
    void read(current.signal).finally(() => {
      if (controller === current) controller = undefined;
    });
  };
  const update = () => {
    for (const el of [main, status, actions, form]) el.hidden = collapsed;
    if (note) note.hidden = collapsed;
    toggle.textContent = collapsed ? t.expand : t.collapse;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    if (collapsed) stop();
    else start();
  };
  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    d.onCollapse(collapsed);
    update();
  });
  exclude.addEventListener("click", () => {
    d.onExclude();
    destroy();
  });
  retry.addEventListener("click", () => {
    stop();
    start();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || sending || destroyed) return;
    sending = true;
    send.disabled = true;
    retry.hidden = true;
    if (!draft || draft.text !== text) draft = { text, id: uuidv4().replace(/-/g, "_") };
    const id = draft.id;
    try {
      const r = await d.call({ op: "send", id, text }, d.principal, controller?.signal);
      if (destroyed) return;
      if (!r.ok) {
        fail(r.error);
        return;
      }
      if (r.kind !== "accepted") {
        fail("unavailable");
        return;
      }
      input.value = "";
      draft = undefined;
      awaitingReplySeq = [...messages.values()].some(
        (m) => m.from === "agent" && (m.seq ?? 0) > r.seq,
      )
        ? undefined
        : r.seq;
      status.textContent = awaitingReplySeq === undefined ? "" : t.connecting;
      // A long read already wakes at acceptance; no second reader or cursor jump is needed.
      if (!controller) start();
    } catch {
      fail("unavailable");
    } finally {
      sending = false;
      send.disabled = false;
    }
  });
  const visible = () => {
    if (doc.visibilityState === "hidden") stop();
    else start();
  };
  doc.addEventListener("visibilitychange", visible);
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    stop();
    doc.removeEventListener("visibilitychange", visible);
    host.remove();
  };
  update();
  // A capability action may call this only after its real permission gate rejects it.
  // Ordinary chat text and normal startup never trigger a privilege notice.
  const advancedDenied = () => {
    if (destroyed) return;
    note?.remove();
    note = doc.createElement("div");
    note.className = "note";
    note.setAttribute("role", "status");
    note.append(doc.createTextNode(d.common.chatOnly + " "));
    const link = doc.createElement("a");
    link.textContent = d.common.advanced;
    link.href = d.origin + portableChatPath(d.hostOrigin);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const dismiss = doc.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", d.common.close);
    dismiss.addEventListener("click", () => {
      note?.remove();
      note = undefined;
    });
    note.append(link, dismiss);
    section.insertBefore(note, main);
    note.hidden = collapsed;
  };
  return {
    advancedDenied,
    destroy,
    collapse(value: boolean) {
      collapsed = value;
      update();
    },
    isCollapsed: () => collapsed,
  };
}
