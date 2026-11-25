"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { portableChatPath } from "@/lib/portable-chat-url";
import { DebugChat } from "@lianki/debug-chat/DebugChat";
import { CHAT_STRINGS_EN, type ChatStrings } from "@lianki/debug-chat/wire";
import { type Guest, startFrameGuest } from "@lianki/debug-chat/embed/frame-guest";
import { type PartnerClient, createPartnerClient } from "@lianki/debug-chat/embed/partner-client";

/**
 * The Learning Partner inside a lianki.com frame on another site
 * (docs/dev-debug-widget.md, "On every site", "The frame"). The frame is
 * cross-origin to the host page, so what he types here never reaches the
 * page's key listeners. It holds no session (third-party: no cookie): it
 * connects only with a ticket the userscript's shell hands over its port,
 * chat only, as the shadow widget did.
 */
export function PartnerFrame({
  strings,
  shareChars,
  chatOnlyText,
  advancedText,
}: {
  strings?: Partial<ChatStrings>;
  chatOnlyText: string;
  advancedText: string;
  /** Config chat.pillShareChars: most characters a shared selection keeps. */
  shareChars?: number;
}) {
  const [client, setClient] = useState<PartnerClient | null>(null);
  const [shell, setShell] = useState<Guest | null>(null);
  const guest = useRef<Guest | null>(null);
  useEffect(() => {
    document.documentElement.dataset.partnerFrame = "";
    let c: PartnerClient | null = null;
    const stop = startFrameGuest(window, (g) => {
      guest.current = g;
      c = createPartnerClient({
        url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/debug`,
        ticket: g.ticket,
        open: (u, p) => new WebSocket(u, p) as never,
        label: () => g.label || "embedded",
        // The parent origin the browser stamped on the hello: a per-site ticket
        // opens only where it was minted for (lib/li-thread.ts, auth.ts ticketSite).
        ...(g.origin ? { query: `&ho=${encodeURIComponent(g.origin)}` } : {}),
        doc: document,
      });
      setShell(g);
      setClient(c);
    });
    return () => {
      stop();
      c?.stop();
    };
  }, []);
  // The chat's box, measured from the frame's bottom-right: the shell sizes the iframe to it.
  useEffect(() => {
    if (!client) return;
    const report = () => {
      const box = document.querySelector("[data-debug-chat]");
      if (!box) return;
      const r = box.getBoundingClientRect();
      guest.current?.size(innerWidth - r.left + 8, innerHeight - r.top + 8);
    };
    const ro = new ResizeObserver(report);
    const mo = new MutationObserver(() => {
      const box = document.querySelector("[data-debug-chat]");
      if (box) ro.observe(box);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    report();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [client]);
  if (!client || !shell) return null;
  return (
    <Chat
      client={client}
      guest={shell}
      strings={strings}
      shareChars={shareChars}
      chatOnlyText={chatOnlyText}
      advancedText={advancedText}
    />
  );
}

function Chat({
  client,
  guest,
  strings,
  shareChars,
  chatOnlyText,
  advancedText,
}: {
  client: PartnerClient;
  guest: Guest;
  chatOnlyText: string;
  advancedText: string;
  strings?: Partial<ChatStrings>;
  shareChars?: number;
}) {
  const s = useSyncExternalStore(client.subscribe, client.get, client.get);
  /** "Nothing to share" after a Share press that found nothing (docs/userscript-li-chat.md, M3). */
  const [note, setNote] = useState<string>();
  return (
    <DebugChat
      embedded
      // No page selection or uploads here: the frame cannot see the host page.
      // Its + menu shares from the page instead, through the userscript (M3).
      attach={false}
      share={
        s.chatOnly
          ? undefined
          : async (what) => {
              const p = await guest.share(what);
              setNote(
                p
                  ? undefined
                  : what === "page"
                    ? (strings?.shareNoPage ?? CHAT_STRINGS_EN.shareNoPage)
                    : (strings?.attachSelectionNone ?? CHAT_STRINGS_EN.attachSelectionNone),
              );
              return p;
            }
      }
      shareChars={shareChars}
      live={s.live}
      listeners={s.listeners}
      messages={s.messages}
      onSend={(text, to, opts) => {
        setNote(undefined);
        return client.send(text, to, opts?.context);
      }}
      busy={s.busy}
      warningHref={
        s.chatOnly
          ? { href: portableChatPath(guest.origin), label: advancedText, newTab: true }
          : undefined
      }
      warning={
        (s.chatOnly ? chatOnlyText : undefined) ??
        note ??
        (s.sendFailed ? (strings?.sendFailed ?? CHAT_STRINGS_EN.sendFailed) : undefined) ??
        s.warning
      }
      viewer={s.viewer}
      agentAvatar="/icon-192.png"
      strings={strings}
    />
  );
}
