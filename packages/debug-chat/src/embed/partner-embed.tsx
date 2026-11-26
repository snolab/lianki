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
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DebugChat } from "../DebugChat";
import { EMBED_NAME, EMBED_STRINGS, embedLang } from "../ui-strings";
import { CHAT_STRINGS_EN } from "../wire";
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
  strings: { name: string; connecting: string; failed: string; advancedHint: string; excludeHere: string };
  /** lianki.com's chat for this website (lib/portable-chat-url.ts), shown with the advanced hint. */
  advancedHref: string;
  onExclude: () => void;
  onInvalidAccount: () => void;
  report?: (what: string, detail: string) => void;
};

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
      strings={{ name: o.strings.name }}
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
  const shadow = createShadowHost(o.doc, o.css);
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
  root.render(<Portable client={client} o={o} portal={shadow.container} />);
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
