import {
  GLOBAL_CHAT_KEY,
  globalChatAllowed,
  globalChatStore,
  chatSiteExcluded,
} from "./pill-chat-global";
import {
  PILL_UI_LANGUAGE_KEY,
  readPortableUiLanguage,
  rememberPortableUiLanguage,
} from "./pill-chat-language";
import { PORTABLE_LI_STRINGS } from "./portable-li-strings";
import { pillChatStrings } from "./pill-chat-strings";
import { PILLCHAT_ON_KEY, flagMirrorOn, siteKey, type GmStore } from "./pill-chat-trust";
import {
  attachPortableStyle,
  PORTABLE_PANEL_CSS,
  type PortableChatCall,
} from "./portable-li-panel";
import {
  PORTABLE_SETTINGS_REQUEST,
  PORTABLE_SETTINGS_STATE,
  parsePortableSettingsRequest,
} from "./portable-li-settings-wire";
import { portableChatPath } from "../lib/portable-chat-url";
const trustedOrigins = new Set([
  "https://lianki.com",
  "https://www.lianki.com",
  "https://preview.lianki.com",
]);
export type PortableWatch = (key: string, changed: () => void) => () => void;
/**
 * An error as a short reason for the debug line and the attribute: its name
 * and first words, letters, digits and spaces only, so no token, URL or page
 * text can ride along.
 */
export function portableWhy(e: unknown): string {
  const err = e as { name?: unknown; message?: unknown } | null;
  const raw = `${typeof err?.name === "string" ? err.name : "Error"}: ${typeof err?.message === "string" ? err.message : String(e)}`;
  return raw
    .replace(/[^A-Za-z0-9 :_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
type PortablePanel = { destroy(): void; collapse(value: boolean): void; isCollapsed(): boolean };
/**
 * The bundled copy of the main site's chat window for 随身Li, for sites whose
 * CSP refuses the lianki.com frame: packages/debug-chat's DebugChat in a
 * closed shadow root (embed/partner-embed.tsx mountPortable), part of the
 * userscript (src/portable-ui-loader.ts). Null in a build without it.
 */
export type PortableUi = {
  mount(o: {
    doc: Document;
    appOrigin: string;
    call: PortableChatCall;
    principal: string;
    /** `portable~<principal>~<site origin>`: drafts never cross accounts or sites. */
    draftScope: string;
    strings: {
      name: string;
      connecting: string;
      failed: string;
      advancedHint: string;
      excludeHere: string;
    };
    advancedHref: string;
    onExclude(): void;
    onInvalidAccount(): void;
  }): { destroy(): void };
};
/** Only the new chat subsystem is managed here. LiCards startup and its legacy credentials are untouched. */
export function startPortableLi(d: {
  gm: GmStore;
  doc: Document;
  win: Window;
  origin: string;
  hostOrigin: string;
  top: boolean;
  call: PortableChatCall;
  watch?: PortableWatch;
  signal?: AbortSignal;
  /**
   * The lianki.com frame (/embed/partner, the same DebugChat, typing private
   * from the page), with its chat-only ticket handed over its MessagePort
   * (src/pill-chat.ts). Tried first; "blocked" (CSP frame-src, no answer) → `ui`.
   */
  frame?: (o: {
    /** The consented account: every ticket must be for it. */
    principal: string;
    /** The ticket was for someone else (or refused as such): close and ask again. */
    onAccountMismatch: () => void;
  }) => { result: Promise<"ready" | "blocked">; destroy(): void };
  /** The bundled copy of the same window, where the frame is refused. */
  ui?: () => Promise<PortableUi | null>;
  /** The userscript's debug reporter: which window drew, or why none did (reason codes only). */
  report?: (what: string, detail: string) => void;
}) {
  const store = globalChatStore(d.gm);
  // Unsupported/non-web documents must disable only portable chat, never abort LiCards startup.
  let host: string | null = null;
  try {
    const url = new URL(d.hostOrigin);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === d.hostOrigin)
      host = siteKey(url.hostname);
  } catch {}
  let panel: PortablePanel | undefined,
    promptClose: (() => void) | undefined,
    destroyed = false,
    generation = 0;
  const trusted = d.top && trustedOrigins.has(d.hostOrigin);
  const settings = () => trusted && d.win.location.pathname.replace(/\/$/, "") === "/chat/sites";
  if (trusted) rememberPortableUiLanguage(d.gm, d.hostOrigin, d.doc.documentElement.lang, true);
  const strings = () => PORTABLE_LI_STRINGS[readPortableUiLanguage(d.gm, d.win.navigator.language)];
  const close = () => {
    generation++;
    panel?.destroy();
    panel = undefined;
    promptClose?.();
    promptClose = undefined;
  };
  const publish = (error = false) => {
    if (!settings()) return;
    const p = store.read();
    d.doc.dispatchEvent(
      new CustomEvent(PORTABLE_SETTINGS_STATE, {
        detail: JSON.stringify({
          installed: true,
          consent: p.consent,
          excluded: p.excluded,
          ...(error ? { error: true } : {}),
        }),
      }),
    );
  };
  const onExclude = () => {
    store.exclude(host!, true);
    panel?.destroy();
    panel = undefined;
    publish();
  };
  const onInvalidAccount = () => {
    store.invalidate();
    close();
    publish(true);
  };
  /**
   * The main site's chat window, the same DebugChat everywhere: first in the
   * lianki.com frame (what he types stays in lianki.com's origin), and where
   * the site's CSP refuses the frame, the copy bundled in the userscript, in a
   * closed shadow root. No other chat UI exists.
   */
  const show = () => {
    if (destroyed || !host || trusted || !d.top || panel || d.doc.visibilityState === "hidden")
      return;
    const p = store.read();
    if (!p.principal || !globalChatAllowed(p, host, p.principal)) return;
    const principal = p.principal;
    const gen = generation;
    let current: { destroy(): void } | undefined;
    let gone = false;
    // Holds the place while the frame answers or the window is drawn, so nothing opens twice.
    const slot: PortablePanel = {
      destroy() {
        gone = true;
        current?.destroy();
        current = undefined;
      },
      collapse() {},
      isCollapsed: () => false,
    };
    panel = slot;
    const live = () => !gone && !destroyed && generation === gen && panel === slot;
    const t = strings();
    void (async () => {
      // Why the window is what it is (or absent), for a real-browser check: a
      // reason code, never a secret (portableWhy).
      let frameWas = d.frame ? "" : "frame:none";
      if (d.frame) {
        try {
          const f = d.frame({
            principal,
            onAccountMismatch: () => {
              if (!live()) return;
              mark("none frame:account-mismatch");
              onInvalidAccount();
            },
          });
          current = f;
          const how = await f.result;
          if (!live()) return f.destroy();
          if (how === "ready") return mark("frame");
          frameWas = "frame:blocked";
          f.destroy();
          current = undefined;
        } catch (e) {
          frameWas = `frame:error ${portableWhy(e)}`;
          current = undefined;
        }
      }
      let ui: PortableUi | null = null;
      try {
        ui = d.ui ? await d.ui() : null;
      } catch (e) {
        if (live()) mark(`none ${frameWas} bundle:error ${portableWhy(e)}`);
        return;
      }
      if (!live()) return;
      if (!ui) return mark(`none ${frameWas} bundle:absent`);
      try {
        current = ui.mount({
          doc: d.doc,
          appOrigin: d.origin,
          call: d.call,
          principal,
          draftScope: `portable~${principal}~${d.hostOrigin}`,
          strings: {
            name: t.title,
            connecting: t.connecting,
            failed: t.failed,
            advancedHint: t.advancedHint,
            excludeHere: t.excludeHere,
          },
          advancedHref: d.origin + portableChatPath(d.hostOrigin),
          onExclude,
          onInvalidAccount,
        });
        mark(`bundled ${frameWas}`);
      } catch (e) {
        mark(`none ${frameWas} mount:error ${portableWhy(e)}`);
      }
    })();
  };
  /** One debug line and `data-lk-portable` on <html>: which window drew, or why none did. */
  const mark = (state: string) => {
    d.report?.("portable-window", state);
    try {
      d.doc.documentElement.setAttribute("data-lk-portable", state);
    } catch {}
  };
  const allow = async () => {
    const gen = ++generation;
    const stamp = store.read().consentStamp;
    const result = await d.call({ op: "hello" });
    if (
      destroyed ||
      generation !== gen ||
      store.read().consentStamp !== stamp ||
      !flagMirrorOn(d.gm.getValue(PILLCHAT_ON_KEY, null))
    )
      return false;
    if (!result.ok || result.kind !== "hello") {
      publish(true);
      return false;
    }
    store.bind(result.principal);
    store.consent("all", result.principal);
    publish();
    show();
    return true;
  };
  const consent = () => {
    if (
      destroyed ||
      promptClose ||
      trusted ||
      !d.top ||
      !host ||
      chatSiteExcluded(store.read(), host)
    )
      return;
    const t = strings(),
      node = d.doc.createElement("lianki-portable-consent"),
      root = node.attachShadow({ mode: "closed" });
    attachPortableStyle(
      root,
      d.doc,
      PORTABLE_PANEL_CSS +
        "section{padding:12px;gap:10px}p{margin:0}h2{font:600 16px/1.4 system-ui;margin:0}.buttons{display:flex;gap:8px;flex-wrap:wrap}",
    );
    const box = d.doc.createElement("section");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", t.consentTitle);
    const title = d.doc.createElement("h2"),
      body = d.doc.createElement("p"),
      buttons = d.doc.createElement("div"),
      yes = d.doc.createElement("button"),
      no = d.doc.createElement("button"),
      status = d.doc.createElement("p");
    title.textContent = t.consentTitle;
    body.textContent = t.consentBody;
    yes.textContent = t.allowAll;
    no.textContent = pillChatStrings(readPortableUiLanguage(d.gm)).notNow;
    buttons.className = "buttons";
    yes.type = no.type = "button";
    status.setAttribute("role", "status");
    buttons.append(yes, no);
    box.append(title, body, buttons, status);
    root.append(box);
    d.doc.documentElement.append(node);
    promptClose = () => node.remove();
    no.addEventListener("click", () => {
      promptClose?.();
      promptClose = undefined;
    });
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      status.textContent = t.connecting;
      try {
        if (await allow()) {
          promptClose?.();
          promptClose = undefined;
        } else {
          status.textContent = t.failed;
          yes.disabled = false;
        }
      } catch {
        status.textContent = t.failed;
        yes.disabled = false;
      }
    });
    // No focus call: opening a website must not steal its typing focus.
  };
  const refresh = () => {
    if (destroyed) return;
    if (trusted) {
      rememberPortableUiLanguage(d.gm, d.hostOrigin, d.doc.documentElement.lang, true);
      publish();
      return;
    }
    const p = store.read();
    if (!flagMirrorOn(d.gm.getValue(PILLCHAT_ON_KEY, null))) {
      promptClose?.();
      promptClose = undefined;
    }
    if (
      !flagMirrorOn(d.gm.getValue(PILLCHAT_ON_KEY, null)) ||
      !host ||
      chatSiteExcluded(p, host) ||
      p.consent !== "all"
    ) {
      panel?.destroy();
      panel = undefined;
      if (p.consent === "unknown" && flagMirrorOn(d.gm.getValue(PILLCHAT_ON_KEY, null))) consent();
      return;
    }
    if (panel) panel.collapse(p.collapsed.includes(host));
    else show();
  };
  const onSettings = async (e: Event) => {
    if (!settings()) return;
    const v = parsePortableSettingsRequest((e as CustomEvent).detail);
    if (!v) return;
    if (v.op === "state") {
      publish();
      return;
    }
    if (v.op === "allow") {
      try {
        await allow();
      } catch {
        publish(true);
      }
      return;
    }
    if (v.op === "off") {
      store.revoke();
      close();
      publish();
      return;
    }
    if (v.op === "exclude") {
      const ok = store.exclude(v.host, v.excluded);
      publish(!ok);
    }
  };
  d.doc.addEventListener(PORTABLE_SETTINGS_REQUEST, onSettings);
  const visible = () => {
    if (d.doc.visibilityState === "visible") refresh();
  };
  d.doc.addEventListener("visibilitychange", visible);
  const languageObserver = trusted
    ? new MutationObserver(() =>
        rememberPortableUiLanguage(d.gm, d.hostOrigin, d.doc.documentElement.lang, true),
      )
    : undefined;
  languageObserver?.observe(d.doc.documentElement, { attributes: true, attributeFilter: ["lang"] });
  const unwatch = [GLOBAL_CHAT_KEY, PILLCHAT_ON_KEY, PILL_UI_LANGUAGE_KEY].map((key) =>
    d.watch?.(key, () => {
      if (key === PILL_UI_LANGUAGE_KEY) close();
      if (key === PILLCHAT_ON_KEY && !flagMirrorOn(d.gm.getValue(PILLCHAT_ON_KEY, null)))
        generation++;
      refresh();
    }),
  );
  const destroy = () => {
    destroyed = true;
    close();
    languageObserver?.disconnect();
    d.doc.removeEventListener(PORTABLE_SETTINGS_REQUEST, onSettings);
    d.doc.removeEventListener("visibilitychange", visible);
    for (const un of unwatch) un?.();
  };
  d.signal?.addEventListener("abort", destroy, { once: true });
  // Defer the first view so initialization does not block LiCards.
  queueMicrotask(refresh);
  return {
    close,
    destroy,
    excluded: () => !host || chatSiteExcluded(store.read(), host),
    active: () =>
      d.top &&
      !!host &&
      (flagMirrorOn(d.gm.getValue(PILLCHAT_ON_KEY, null)) || store.read().consent !== "unknown"),
    open: async () => {
      if (panel) {
        const p = store.read();
        store.collapse(host!, !panel.isCollapsed());
        refresh();
        return "ready" as const;
      }
      const p = store.read();
      if (p.consent === "all") {
        show();
        return "ready" as const;
      }
      consent();
      return "denied" as const;
    },
    manage: () => {
      d.win.open(d.origin + "/chat/sites", "_blank", "noopener,noreferrer");
      return { remove() {}, closed: Promise.resolve() };
    },
  };
}
