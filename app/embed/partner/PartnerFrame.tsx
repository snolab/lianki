"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DebugChat } from "@lianki/debug-chat/DebugChat";
import type { ChatStrings } from "@lianki/debug-chat/wire";
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
export function PartnerFrame({ strings }: { strings?: Partial<ChatStrings> }) {
  const [client, setClient] = useState<PartnerClient | null>(null);
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
        doc: document,
      });
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
  if (!client) return null;
  return <Chat client={client} strings={strings} />;
}

function Chat({ client, strings }: { client: PartnerClient; strings?: Partial<ChatStrings> }) {
  const s = useSyncExternalStore(client.subscribe, client.get, client.get);
  return (
    <DebugChat
      embedded
      live={s.live}
      listeners={s.listeners}
      messages={s.messages}
      onSend={(text, to) => client.send(text, to)}
      busy={s.busy}
      warning={s.warning}
      viewer={s.viewer}
      agentAvatar="/icon-192.png"
      strings={strings}
    />
  );
}
