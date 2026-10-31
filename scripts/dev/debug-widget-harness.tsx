/**
 * A stand-in host page for the hot-loaded debug chat, served by
 * scripts/dev/debug-widget-server.ts at /harness. It renders the real
 * DebugChatHost (the loader DebugEval uses) with made-up messages, so the
 * import, React sharing and reload can be checked without lianki-push.
 * `?busy=1` shows the heartbeat spinner; `?pending=chat|eval|friend` the pairing modal;
 * `__remount()` remounts the chat (a hot swap); `__devLog` collects the voice
 * session's debug events. `?notree` passes no state tree content, `?nofrontier` no frontier lines; `?min` starts minimized (`?open` expanded; neither keeps what was last chosen).
 * `__polish(text)` polishes the owner's latest line as the agent's `edit`
 * does (raw kept, an "edited" mark); `__sent` records each send's `source`.
 * `globalThis.__push(text, from?, at?)` adds a live message (`at` may be skewed), e.g. to float one up
 * over the minimized bar; `?cap=N` caps the list at N, as the app does.
 * `?busy=1` shows the heartbeat spinner; `?pending=chat|eval|friend` the pairing modal.
 * Avatars: the agent's is an element (the liagent mark, standing in for the
 * host's logo), the viewer's a picture, and two friend lines show the
 * fallback initial (one picture that fails to load, one with none).
 * `?nopic=1` drops the viewer's picture, so their lines show the initial too.
 * Node paths: two state-tree nodes' agents speak (a subtitle "/words ›
 * prefetch" and a left border by node), one addresses another ("from →
 * to"), and the owner's line to a node shows "→ /words › prefetch". Typing
 * "@/" offers the listed nodes; `?target=/words/prefetch` starts with that chip.
 */
import { type Ask, askText } from "@lianki/debug-chat/ask";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type { ChatMessage } from "@/lib/dev-eval";
import { DebugChatHost } from "@lianki/debug-chat/DebugChatHost";
import { DebugPairModal } from "@lianki/debug-chat/DebugPairModal";
import { voice } from "@lianki/debug-chat/voice";
import { clipPosted, onClipsState, setClipsSender } from "@lianki/debug-chat/clips-store";

{
  // Before the first render: the chat reads it once, when it mounts.
  const q = new URLSearchParams(location.search);
  const open = q.has("min") ? "0" : q.has("open") ? "1" : null;
  try {
    if (open) localStorage.setItem("lk:debug-chat-open", open);
  } catch {}
}

// The devLog stand-in: the voice session's debug events (e.g. mic-resume) land here.
voice().setLog((ev) => {
  const w = globalThis as { __devLog?: unknown[] };
  (w.__devLog ??= []).push(ev);
});

import { STATE_TREE_MD } from "@/lib/state-tree.generated";
import { LiagentMark } from "@lianki/debug-chat/LiagentMark";
import { setTarget } from "@lianki/debug-chat/DebugChat";

/** A made-up profile picture: no network, so the harness works offline. */
const PIC = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="oklch(0.62 0.15 250)"/><circle cx="18" cy="14" r="7" fill="oklch(0.95 0.02 250)"/><path d="M5 36a13 11 0 0 1 26 0" fill="oklch(0.95 0.02 250)"/></svg>`,
)}`;
/** Two other people's lines: a picture that fails (falls back to the initial), and none. */
const FRIENDS: ChatMessage[] = [
  {
    id: "f1",
    from: "friend",
    label: "/words Android",
    text: "a friend whose picture fails to load",
    at: Date.parse("2026-10-29T00:01:00Z"),
    thread: "friend-a",
    sender: { id: "k3x9", name: "Ada", avatars: ["https://example.com/missing-avatar.png"] },
  },
  {
    id: "f2",
    from: "friend",
    label: "/home iPhone",
    text: "a friend with no picture",
    at: Date.parse("2026-10-29T00:02:00Z"),
    thread: "friend-b",
    sender: { id: "p7q2", name: "Émile" },
  },
];

/** Lines from state-tree nodes: two sub-agents, one agent → agent, and the owner's to a node. */
const NODES: ChatMessage[] = [
  {
    id: "n1",
    from: "agent",
    label: "sub-agent",
    agentId: "prefetcher",
    taskPath: "/words/prefetch",
    text: "warming audio for the next 20 rows",
    at: Date.parse("2026-10-29T00:03:00Z"),
  },
  {
    id: "n2",
    from: "owner",
    label: "/harness",
    to: "/words/prefetch",
    text: "skip the images for now",
    at: Date.parse("2026-10-29T00:04:00Z"),
  },
  {
    id: "n3",
    from: "agent",
    label: "sub-agent",
    agentId: "audio",
    taskPath: "/words/audio",
    text: "TTS cache is cold on iOS",
    at: Date.parse("2026-10-29T00:05:00Z"),
  },
  {
    id: "n4",
    from: "agent",
    label: "sub-agent",
    agentId: "prefetcher",
    taskPath: "/words/prefetch",
    to: "/words/audio",
    text: "I will fetch those clips first",
    at: Date.parse("2026-10-29T00:06:00Z"),
  },
];
const HARNESS_NODES = ["/words", "/words/prefetch", "/words/audio", "/home/sites"];

function Harness() {
  /** `__remount()`: the chat unmounts and mounts again, as a hot swap does. */
  const [gen, setGen] = useState(0);
  (globalThis as { __remount?: () => void }).__remount = () => setGen((g) => g + 1);
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    Array.from(
      { length: 30 },
      (_, i): ChatMessage => ({
        id: `h${i}`,
        from: i % 2 ? "agent" : "owner",
        label: i % 2 ? "agent" : "/harness",
        text: `message ${i}`,
        at: Date.parse("2026-10-29T00:00:00Z") + i * 1000,
      }),
    ).concat(FRIENDS, NODES),
  );
  const q = new URLSearchParams(location.search);
  const startTarget = q.get("target");
  useEffect(() => {
    if (startTarget) setTarget(startTarget);
  }, [startTarget]);
  const busy = q.has("busy");
  const pending = q.get("pending");
  const record = (key: string, v: unknown) => {
    const w = globalThis as unknown as Record<string, unknown[]>;
    (w[key] ??= []).push(v);
  };
  // `?cap=N` keeps only the last N, as the app's trimHistory does: once
  // full, the list stays the same length as new lines come in.
  const cap = Number(q.get("cap")) || 0;
  const add = (l: ChatMessage[], m: ChatMessage) => (cap ? [...l, m].slice(-cap) : [...l, m]);
  (
    globalThis as {
      __push?: (text: string, from?: "agent" | "owner", at?: number) => void;
    }
  ).__push = (text, from = "agent", at = Date.now()) =>
    setMessages((l) =>
      add(l, {
        id: crypto.randomUUID(),
        from,
        label: from === "agent" ? "agent" : "/harness",
        text,
        at,
      }),
    );
  // An ask card from the agent (ask.ts): `__ask({ askId, questions })`.
  (globalThis as { __ask?: (ask: Ask) => void }).__ask = (ask) =>
    setMessages((l) =>
      add(l, {
        id: `ask-${ask.askId}`,
        from: "agent",
        label: "agent",
        text: askText(ask),
        at: Date.now(),
        ask,
      }),
    );
  (globalThis as { __polish?: (text: string) => void }).__polish = (text) =>
    setMessages((l) => {
      const i = l.findLastIndex((m) => m.from === "owner" && !m.thread);
      if (i < 0) return l;
      const m = l[i];
      const count = (m.edited?.count ?? 0) + 1;
      const next = {
        ...m,
        source: "stt" as const,
        text,
        raw: m.raw ?? m.text,
        edited: { at: Date.now(), by: "agent", count },
      };
      return [...l.slice(0, i), next, ...l.slice(i + 1)];
    });
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
        key={gen}
        hot
        agentAvatar={<LiagentMark size={14} />}
        viewer={{ id: "v1", name: "Harness Owner", avatars: q.has("nopic") ? [] : [PIC] }}
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
        // The tree: docs/state-tree.md (`?statictree`: a small static outline;
        // `?notree`: none, for the lk:tree-src fallback).
        treeSource={q.has("notree") || q.has("statictree") ? undefined : () => STATE_TREE_MD}
        treeRepo="snolab/lianki"
        renderTree={q.has("statictree") ? () => <HarnessTree /> : undefined}
        // Minimized: a single title, a group (collapsed; tap to list it), a next
        // (`?nofrontier`: the tree's own frontier).
        frontier={q.has("nofrontier") ? undefined : FRONTIER}
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
        nodes={HARNESS_NODES}
        // As the hub would: record the tap, then stamp the answer onto the ask's line.
        onAnswer={(askId, choices) => {
          record("__answers", { askId, choices });
          setTimeout(
            () =>
              setMessages((l) =>
                l.map((m) =>
                  m.ask?.askId === askId
                    ? {
                        ...m,
                        answer: {
                          choices,
                          source: "tap",
                          thread: "owner",
                          label: "/harness",
                          at: Date.now(),
                        },
                      }
                    : m,
                ),
              ),
            50,
          );
          return !q.has("noanswer");
        }}
        onSend={(text, to, opts) => {
          record("__sent", { text, source: opts?.source ?? null });
          setMessages((l) =>
            add(l, {
              id: crypto.randomUUID(),
              from: "owner",
              label: "/harness",
              text,
              at: Date.now(),
              ...(to ? { to } : {}),
              ...(opts?.source ? { source: opts.source } : {}),
            }),
          );
          return true;
        }}
      />
    </>
  );
}

/** Static frontier lines for the minimized bar: one agent and one human at work. */
const FRONTIER = {
  done: { text: "Unified chat bar" },
  doing: {
    text: "多线并进",
    count: 3,
    assignee: { type: "agent" as const, name: "main lane", id: "lane-main-7f3a9c" },
    items: [
      {
        title: "Frontier lines",
        path: "chat › bar › minimized",
        assignee: { type: "agent" as const, name: "main lane", id: "lane-main-7f3a9c" },
      },
      {
        title: "Avatars in the log",
        path: "chat › log",
        assignee: { type: "agent" as const, name: "avatar lane", id: "lane-avatar-2b81d0" },
      },
      {
        title: "Review the preview",
        path: "owner › review",
        assignee: { type: "human" as const, name: "Ada" },
      },
    ],
  },
  next: { text: "Tree source from the state tree" },
};

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
        <li
          key={`${depth}${key}`}
          // Rows take the pointer (the tree is otherwise click-through), so it scrolls.
          className="pointer-events-auto"
          style={{ paddingInlineStart: `${depth}rem` }}
        >
          <span className="opacity-60">{depth ? "└ " : ""}</span>
          {key}
          {value && <span className="opacity-60">: {value}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * `?clips=on|failing|remind|continue`: the recording badge with a made-up
 * hub (clips-store.ts): on with 3 clips saved; a failed save; 4 min left of
 * an auto-stop; another window's session offered. Stop and Continue answer
 * as the hub would (with a sink set up, so the menu offers "Record voice clips").
 */
{
  const q = new URLSearchParams(location.search);
  const mode = q.get("clips");
  if (mode) {
    const sid = "harnessSESSIONsid0001";
    const device = "harnessDEVICEid000001";
    const sink = "https://example.ts.net/lianki-widget";
    const on = (extra: Record<string, unknown> = {}) =>
      onClipsState({ type: "clips", sid, device, on: true, since: Date.now(), sink, ...extra });
    setClipsSender((m) => {
      if (m.type === "clips-off")
        onClipsState({ type: "clips", sid, device, on: false, canStart: true });
      else if (m.type === "clips-on" || m.type === "clips-adopt")
        on(m.type === "clips-on" && m.minutes ? { left: m.minutes * 60_000 } : {});
      return true;
    });
    if (mode === "continue")
      onClipsState({
        type: "clips",
        sid,
        device,
        on: false,
        canStart: true,
        resumable: [
          { sid: "otherWINDOWsession01", label: "/words pwa Android", since: Date.now() },
        ],
      });
    else {
      on(mode === "remind" ? { left: 4 * 60_000 } : {});
      if (mode !== "remind") for (let i = 0; i < 3; i++) clipPosted({ ok: true }, sink);
      if (mode === "failing") clipPosted({ ok: false, status: 502, error: "sink 502" }, sink);
    }
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
