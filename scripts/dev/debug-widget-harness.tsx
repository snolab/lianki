/**
 * A stand-in host page for the hot-loaded debug chat, served by
 * scripts/dev/debug-widget-server.ts at /harness. It renders the real
 * DebugChatHost (the loader DebugEval uses) with made-up messages, so the
 * import, React sharing and reload can be checked without lianki-push.
 * `?busy=1` shows the heartbeat spinner; `?pending=chat|eval|friend` the pairing modal;
 * `?notree` passes no state tree content; `?min` starts minimized (`?open` expanded; neither keeps what was last chosen).
 * `globalThis.__push(text, from?)` adds a live message, e.g. to float one up
 * over the minimized bar.
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ChatMessage } from "@/lib/dev-eval";
import { DebugChatHost } from "@lianki/debug-chat/DebugChatHost";
import { DebugPairModal } from "@lianki/debug-chat/DebugPairModal";

{
  // Before the first render: the chat reads it once, when it mounts.
  const q = new URLSearchParams(location.search);
  const open = q.has("min") ? "0" : q.has("open") ? "1" : null;
  try {
    if (open) localStorage.setItem("lk:debug-chat-open", open);
  } catch {}
}

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
  (globalThis as { __push?: (text: string, from?: "agent" | "owner") => void }).__push = (
    text,
    from = "agent",
  ) =>
    setMessages((l) => [
      ...l,
      {
        id: crypto.randomUUID(),
        from,
        label: from === "agent" ? "agent" : "/harness",
        text,
        at: Date.now(),
      },
    ]);
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
        // A small static outline for the state tree sheet (`?notree`: none).
        renderTree={q.has("notree") ? undefined : () => <HarnessTree />}
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

/** A stand-in for the state tree: a small static outline. */
function HarnessTree() {
  const rows: [number, string, string?][] = [
    [0, "page", "/harness"],
    [1, "chat", "open"],
    [2, "messages", "30"],
    [2, "voice", "mic off · speaker on"],
    [1, "sessions", "2"],
    [2, "agent", "chat"],
    [2, "main lane", "eval"],
    [1, "pages", "3"],
    // Enough rows to scroll the sheet and the column.
    ...Array.from({ length: 30 }, (_, i): [number, string, string?] => [
      2 + (i % 2),
      `card ${i + 1}`,
      i % 3 ? "due" : "new",
    ]),
  ];
  return (
    <ul data-testid="harness-tree" className="list-none space-y-0.5 font-mono text-[11px]">
      {rows.map(([depth, key, value]) => (
        <li key={`${depth}${key}`} style={{ paddingInlineStart: `${depth}rem` }}>
          <span className="opacity-60">{depth ? "└ " : ""}</span>
          {key}
          {value && <span className="opacity-60">: {value}</span>}
        </li>
      ))}
    </ul>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
