/**
 * The Learning Partner on every site: the entry the userscript runs
 * (docs/dev-debug-widget.md, "On every site"). Built by
 * scripts/build-partner-embed.ts into one script with its own React, its CSS
 * and shims for storage and network (so nothing lands in the site's storage
 * and no request goes to the site), and evaluated by the userscript only on
 * the owner's browser, in the manager's own world.
 *
 * It renders into a closed shadow root (isolation.ts) and talks to the hub
 * over a ticket socket (partner-client.ts). When it must not run here, a
 * small note says why instead (guard.ts).
 */
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DebugChat } from "../DebugChat";
import { EMBED_NAME, EMBED_STRINGS, embedLang } from "../ui-strings";
import { CHAT_STRINGS_EN, type ChatStrings } from "../wire";
import { type Blocker, blockerText, cspBlocker } from "./guard";
import { createShadowHost } from "./isolation";
import { type PartnerClient, type PartnerDeps, createPartnerClient, pageLabel } from "./partner-client";
import { type PortableCall, type PortableClient, createPortableClient } from "./portable-client";

export type MountOptions = {
  doc: Document;
  /** The widget's CSS (Tailwind utilities, the app's colours), isolated on the way in. */
  css: string[];
  /** lianki.com (or the app the dev loader points at). */
  appOrigin: string;
  /** A fresh ticket from the userscript (GM_xmlhttpRequest), or null. */
  ticket: () => Promise<string | null>;
  /** The page's real WebSocket (the widget's own is shimmed away). */
  WebSocket: new (url: string, protocols: string[]) => unknown;
  /** Hide the partner on this site (the note's ×): the userscript remembers it. */
  hide: () => void;
  /** Forced from the start (the userscript already knows it cannot run here). */
  blocked?: Blocker;
  /**
   * Read-only (the site blocks the private typing frame): replies show, the
   * input is replaced by a note and a link to reply on lianki.com. Keys typed
   * here could be read by the site's capture listeners, so none are asked for.
   */
  readOnly?: boolean;
  /** Errors go to the userscript's reporter (the dev loader's sink), never the page. */
  report?: (what: string, detail: string) => void;
};

/** `root` is for the QA only: the userscript never hands it to the page. */
export type Mounted = { client: PartnerClient; root: ShadowRoot; destroy(): void };

const GLASS = "oklch(0.97 0.01 82 / 0.9)";
const INK = "oklch(0.25 0.02 65)";

function Note({ text, appOrigin, onHide, hideLabel, openLabel }: {
  text: string;
  appOrigin: string;
  onHide: () => void;
  hideLabel: string;
  openLabel: string;
}) {
  return (
    <div
      role="status"
      data-testid="partner-note"
      style={{
        position: "fixed",
        right: "8px",
        bottom: "calc(8px + env(safe-area-inset-bottom))",
        maxWidth: "min(320px, calc(100vw - 16px))",
        padding: "10px 12px",
        borderRadius: "12px",
        background: GLASS,
        color: INK,
        border: "1px solid oklch(0.25 0.02 65 / 0.15)",
        backdropFilter: "blur(12px) saturate(1.4)",
        WebkitBackdropFilter: "blur(12px) saturate(1.4)",
        fontSize: "13px",
        lineHeight: "18px",
        pointerEvents: "auto",
        display: "flex",
        gap: "8px",
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: "1 1 auto" }}>
        <div>{text}</div>
        <a
          href={appOrigin}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "oklch(0.45 0.132 22.3)", textDecoration: "underline", display: "inline-block", marginTop: "4px" }}
        >
          {openLabel}
        </a>
      </div>
      <button
        type="button"
        aria-label={hideLabel}
        title={hideLabel}
        onClick={onHide}
        style={{
          flex: "0 0 auto",
          width: "40px",
          height: "40px",
          margin: "-10px -8px -10px 0",
          border: "0",
          background: "transparent",
          color: INK,
          fontSize: "18px",
          lineHeight: "40px",
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>
  );
}

function Partner({ client, o, portal }: { client: PartnerClient; o: MountOptions; portal: Element }) {
  const s = useSyncExternalStore(client.subscribe, client.get, client.get);
  const lang = embedLang();
  const name = EMBED_NAME[lang];
  const strings = EMBED_STRINGS[lang];
  if (s.blocked)
    return (
      <Note
        text={blockerText(s.blocked, strings, name)}
        appOrigin={o.appOrigin}
        onHide={o.hide}
        hideLabel={strings.hideHere}
        openLabel={strings.openLianki}
      />
    );
  return (
    <DebugChat
      embedded
      portalRoot={portal}
      live={s.live}
      listeners={s.listeners}
      messages={s.messages}
      onSend={(text, to, opts) => client.send(text, to, opts?.context)}
      busy={s.busy}
      warning={s.sendFailed ? CHAT_STRINGS_EN.sendFailed : s.warning}
      viewer={s.viewer}
      agentAvatar={`${o.appOrigin}/icon-192.png`}
      strings={{ name }}
      {...(o.readOnly
        ? {
            notice: strings.readOnly,
            noticeHref: { href: o.appOrigin, label: strings.replyOnLianki },
          }
        : {})}
    />
  );
}

export type PortableMountOptions = {
  doc: Document;
  /** The widget's CSS, as for the partner (isolated on the way in). */
  css: string[];
  appOrigin: string;
  /** The userscript's chat-only broker (read / send), never a ticket or token. */
  call: PortableCall;
  /** The account the broker bound at consent (x-lianki-chat-principal). */
  principal: string;
  /**
   * Where the composer's draft is kept: one per account and site (the
   * userscript passes `portable~<principal>~<origin>`), so a draft typed on
   * one site or as one account never shows on another. Required.
   */
  draftScope: string;
  /** From the userscript's tables (src/portable-li-strings.ts, intlayer `portable-li`). */
  strings: {
    name: string;
    connecting: string;
    failed: string;
    advancedHint: string;
    excludeHere: string;
    /** The panel's minimize button (intlayer portable-li `collapse`). */
    collapse?: string;
    /** The Li button that opens it again (intlayer portable-li `expand`). */
    expand?: string;
  };
  /** The chat's own strings in his Lianki language (intlayer `learning-partner`), bundled by the userscript. */
  chatStrings?: Record<string, string>;
  /** lianki.com's chat for this website (lib/portable-chat-url.ts), shown with the advanced hint. */
  advancedHref: string;
  onExclude: () => void;
  onInvalidAccount: () => void;
  report?: (what: string, detail: string) => void;
};

/** 随身Li's window size: as the frame's (src/pill-chat.ts PORTABLE_FRAME_SIZE). */
export const PORTABLE_PANEL_SIZE = {
  w: "min(420px, calc(100vw - 16px))",
  h: "min(560px, calc(100vh - 24px))",
};
const SEAL = "oklch(0.53 0.207 22.3)";
/**
 * Inside the panel the chat fills it under the title bar, fully opaque (the
 * main site fades an idle chat; on a third-party page it must stay readable).
 */
const PORTABLE_PANEL_CSS = `[data-lk-portable-panel] [data-debug-chat]{left:8px!important;right:8px!important;width:auto!important;bottom:8px!important;opacity:1!important;max-height:calc(100% - 52px)!important}`;

/**
 * The solid window around DebugChat on someone else's page: opaque (theme
 * tokens, light and dark), bordered, shadowed, anchored bottom-right at a
 * fixed size. Its transform makes it the containing block of DebugChat's own
 * fixed-position parts, so the chat lays out inside it as on a small screen,
 * never floating over the page. Minimize leaves a Li button; both carry
 * `data-lk-portable-toggle`.
 */
function PortablePanel({ client, o }: { client: PortableClient; o: PortableMountOptions }) {
  const [open, setOpen] = useState(true);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const collapse = o.strings.collapse ?? "Minimize";
  const expand = o.strings.expand ?? o.strings.name;
  if (!open)
    return (
      <button
        type="button"
        data-lk-portable-toggle="open"
        aria-label={expand}
        title={expand}
        onClick={() => setOpen(true)}
        style={{
          position: "fixed",
          right: "16px",
          bottom: "16px",
          width: "48px",
          height: "48px",
          borderRadius: "999px",
          background: SEAL,
          color: "oklch(0.99 0 0)",
          font: "600 16px/48px system-ui, sans-serif",
          textAlign: "center",
          boxShadow: "0 6px 20px oklch(0 0 0 / 0.3)",
          pointerEvents: "auto",
          cursor: "pointer",
        }}
      >
        Li
      </button>
    );
  return (
    <div
      ref={setPanel}
      data-lk-portable-panel=""
      role="dialog"
      aria-label={o.strings.name}
      style={{
        position: "fixed",
        right: "16px",
        bottom: "16px",
        width: PORTABLE_PANEL_SIZE.w,
        height: PORTABLE_PANEL_SIZE.h,
        // Opaque, from the app's own tokens (globals.css, light and dark).
        background: "var(--background, oklch(0.99 0.005 82))",
        color: "var(--foreground, oklch(0.25 0.02 65))",
        border: "1px solid color-mix(in oklch, var(--foreground, oklch(0.25 0.02 65)) 18%, transparent)",
        borderRadius: "16px",
        boxShadow: "0 12px 40px oklch(0 0 0 / 0.3)",
        overflow: "hidden",
        // The containing block for DebugChat's fixed parts.
        transform: "translateZ(0)",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "44px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "0 8px 0 14px",
          borderBottom: "1px solid color-mix(in oklch, var(--foreground, oklch(0.25 0.02 65)) 12%, transparent)",
          font: "600 14px/1 system-ui, sans-serif",
          zIndex: 1,
        }}
      >
        <span style={{ flex: "1 1 auto", minWidth: 0 }}>{o.strings.name}</span>
        <button
          type="button"
          data-lk-portable-toggle="close"
          aria-label={collapse}
          title={collapse}
          onClick={() => setOpen(false)}
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "999px",
            font: "400 20px/40px system-ui, sans-serif",
            textAlign: "center",
            cursor: "pointer",
            color: "inherit",
          }}
        >
          –
        </button>
      </div>
      {panel && <Portable client={client} o={o} portal={panel} />}
    </div>
  );
}

function Portable({ client, o, portal }: { client: PortableClient; o: PortableMountOptions; portal: Element }) {
  const s = useSyncExternalStore(client.subscribe, client.get, client.get);
  // Errors carry their own glyph and words, never the brand red alone.
  const warning =
    s.problem === "advanced" ? o.strings.advancedHint : s.problem === "failed" ? `⚠ ${o.strings.failed}` : undefined;
  return (
    <DebugChat
      embedded
      attach={false}
      draftScope={o.draftScope}
      portalRoot={portal}
      live={s.live}
      // Li answers through the hub's AI reply whenever the broker reads: present while connected.
      listeners={s.live ? 1 : 0}
      messages={s.messages}
      outgoing={s.outgoing}
      onSend={(text, to, opts) => client.send(text, to, opts)}
      busy={s.busy}
      warning={warning}
      {...(s.problem === "advanced"
        ? { warningHref: { href: o.advancedHref, label: "lianki.com ↗", newTab: true as const } }
        : {})}
      agentAvatar={`${o.appOrigin}/icon-192.png`}
      strings={{ ...(o.chatStrings as Partial<ChatStrings> | undefined), name: o.strings.name }}
      menuItems={[{ id: "exclude", label: o.strings.excludeHere, onSelect: o.onExclude }]}
    />
  );
}

/**
 * 随身Li (portable Li): the main site's chat window, DebugChat itself, in a
 * closed shadow root on a site, fed only by the userscript's chat-only broker.
 */
export function mountPortable(o: PortableMountOptions): {
  portable: PortableClient;
  /** For the tests and QA only: the userscript never hands it to the page. */
  root: ShadowRoot;
  destroy(): void;
} {
  // No scope = the shared, unscoped draft store: another account or site would see it.
  if (typeof o.draftScope !== "string" || !o.draftScope.startsWith("portable~"))
    throw new Error("portable chat needs an account and site draft scope");
  const shadow = createShadowHost(o.doc, [...o.css, PORTABLE_PANEL_CSS]);
  if (shadow.styles === "blocked") {
    shadow.destroy();
    throw new Error("styles blocked");
  }
  const client = createPortableClient({
    call: o.call,
    principal: o.principal,
    doc: o.doc,
    busyLabel: o.strings.name,
    failedLabel: o.strings.failed,
    onInvalidAccount: o.onInvalidAccount,
  });
  const root = createRoot(shadow.container, {
    onUncaughtError: (err) => o.report?.("portable-render", String((err as Error)?.message ?? err)),
  });
  root.render(<PortablePanel client={client} o={o} />);
  return {
    portable: client,
    root: shadow.root,
    destroy() {
      client.stop();
      root.unmount();
      shadow.destroy();
    },
  };
}

/** Mount the partner (or its note) in a closed shadow root on its own host element. */
export function mountPartner(o: MountOptions): Mounted {
  const shadow = createShadowHost(o.doc, o.css);
  const win = o.doc.defaultView ?? window;
  const hub = `${o.appOrigin.replace(/^http/, "ws")}/api/version/debug`;
  const deps: PartnerDeps = {
    url: hub,
    ticket: o.ticket,
    open: (url, protocols) => new o.WebSocket(url, protocols) as ReturnType<PartnerDeps["open"]>,
    label: () => pageLabel(win.location, win.navigator.userAgent),
    doc: o.doc,
    // Errors go to the userscript's reporter when there is one, never the page.
    ...(o.report
      ? { onSendError: (e: unknown) => o.report?.("partner-send", String((e as Error)?.message ?? e)) }
      : {}),
  };
  const client = createPartnerClient(deps);
  if (o.blocked) client.block(o.blocked);
  else if (shadow.styles === "blocked") client.block("styles");
  // A CSP report about us (the socket, our styles): the note says so.
  const onViolation = (e: SecurityPolicyViolationEvent) => {
    const b = cspBlocker(e, [o.appOrigin]);
    if (b) {
      o.report?.("partner-csp", `${e.effectiveDirective} ${e.blockedURI}`);
      client.block(b);
    }
  };
  o.doc.addEventListener("securitypolicyviolation", onViolation);
  const root = createRoot(shadow.container, {
    onUncaughtError: (err) => {
      o.report?.("partner-render", String((err as Error)?.message ?? err));
      client.block("load");
      // The crashed tree is gone: render again, now as the note.
      queueMicrotask(() => root.render(<Partner client={client} o={o} portal={shadow.container} />));
    },
  });
  root.render(<Partner client={client} o={o} portal={shadow.container} />);
  return {
    client,
    root: shadow.root,
    destroy() {
      o.doc.removeEventListener("securitypolicyviolation", onViolation);
      client.stop();
      root.unmount();
      shadow.destroy();
    },
  };
}
