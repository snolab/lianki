/**
 * A stand-in host page for the hot-loaded debug chat, served by
 * scripts/dev/debug-widget-server.ts at /harness. It renders the real
 * DebugChatHost (the loader DebugEval uses) with made-up messages, so the
 * import, React sharing and reload can be checked without lianki-push.
 * `?working=1` shows the heartbeat spinner.
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ChatMessage } from "@/lib/dev-eval";
import { DebugChatHost } from "@/app/components/DebugChatHost";

function Harness() {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    Array.from({ length: 30 }, (_, i) => ({
      id: `h${i}`,
      from: i % 2 ? "agent" : "owner",
      label: i % 2 ? "agent" : "/harness",
      text: `message ${i}`,
      at: Date.parse("2026-10-29T00:00:00Z") + i * 1000,
    })),
  );
  const working = new URLSearchParams(location.search).has("working");
  return (
    <DebugChatHost
      hot
      live
      listeners={1}
      messages={messages}
      working={working ? { label: "agent" } : null}
      sessions={[
        { pair: "c1", code: "ab12", label: "agent", at: 0, until: 4e12, scope: "chat" },
        { pair: "e1", code: "cd34", label: "main lane", at: 0, until: 4e12, scope: "eval" },
      ]}
      pages={[
        { id: "p1", label: "/harness Chrome", at: 0 },
        { id: "p2", label: "/words pwa iPhone", at: 0 },
      ]}
      selfPage="p1"
      onOpenPage={(path) => {
        const w = globalThis as { __opened?: string[] };
        (w.__opened ??= []).push(path);
      }}
      onEndPage={(id) => {
        const w = globalThis as { __endedPages?: string[] };
        (w.__endedPages ??= []).push(id);
      }}
      // The browser test reads which sessions were ended.
      onEnd={(x) => {
        const w = globalThis as { __ended?: string[] };
        (w.__ended ??= []).push(x.pair);
      }}
      onSend={(text) => {
        setMessages((l) => [
          ...l,
          { id: crypto.randomUUID(), from: "owner", label: "/harness", text, at: Date.now() },
        ]);
        return true;
      }}
    />
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
