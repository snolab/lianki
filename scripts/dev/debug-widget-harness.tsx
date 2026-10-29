/**
 * A stand-in host page for the hot-loaded debug chat, served by
 * scripts/dev/debug-widget-server.ts at /harness. It renders the real
 * DebugChatHost (the loader DebugEval uses) with made-up messages, so the
 * import, React sharing and reload can be checked without lianki-push.
 * `?busy=1` shows the heartbeat spinner; `?pending=chat|eval|friend` the pairing modal.
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ChatMessage } from "@/lib/dev-eval";
import { DebugChatHost } from "@lianki/debug-chat/DebugChatHost";
import { DebugPairModal } from "@lianki/debug-chat/DebugPairModal";
import { STATE_TREE_MD } from "@/lib/state-tree.generated";

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
  const q = new URLSearchParams(location.search);
  const busy = q.has("busy");
  const pending = q.get("pending");
  const record = (key: string, v: unknown) => {
    const w = globalThis as unknown as Record<string, unknown[]>;
    (w[key] ??= []).push(v);
  };
  const pages = [
    { id: "p1", label: "/harness Chrome", at: 0 },
    { id: "p2", label: "/words pwa Mozilla/5.0 (iPhone)", at: 0 },
    { id: "p3", label: "/home Mozilla/5.0 (Macintosh)", at: 0 },
  ];
  return (
    <>
      {pending && (
        <DebugPairModal
          pending={{
            pair: "x",
            code: "a1b2",
            label: "agent on mac",
            at: 0,
            scope: pending === "chat" ? "chat" : "eval",
          }}
          friend={pending === "friend"}
          pages={pages}
          selfPage="p1"
          onAllow={(p) => record("__allowed", p)}
          onDeny={() => record("__denied", true)}
        />
      )}
      <DebugChatHost
        hot
        live
        listeners={q.has("offline") ? 0 : 1}
        messages={messages}
        busy={busy ? { label: "agent" } : null}
        sessions={[
          { pair: "c1", code: "ab12", label: "agent", at: 0, until: 4e12, scope: "chat" },
          { pair: "e1", code: "cd34", label: "main lane", at: 0, until: 4e12, scope: "eval" },
        ]}
        pages={pages}
        selfPage="p1"
        // The Tree view (menu → Tree) shows docs/state-tree.md.
        treeSource={() => STATE_TREE_MD}
        treeRepo="snolab/lianki"
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
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
