"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LANES, type LaneId } from "@lianki/debug-chat/voices";
import { laneAvatar } from "@lianki/debug-chat/LaneMark";
import { longDate } from "@/lib/dates";
import { dayRange, dayRows, plainText } from "@/lib/chat-history-view";
import { VirtualList } from "@/app/components/VirtualList";
import { useInfiniteList } from "@/app/components/useInfiniteList";
import type { ChatHistoryLine, LaneFilter } from "@/lib/chat-log";

export type HistoryLabels = {
  title: string;
  follows: string;
  search: string;
  filterLabel: string;
  all: string;
  you: string;
  empty: string;
  noMatch: string;
  loading: string;
  failed: string;
  retry: string;
  deleteLine: string;
  deleteDay: string;
  confirmLine: string;
  confirmDay: string;
  deleteFailed: string;
  askTag: string;
  answered: string;
  signIn: string;
  /** The main lane's name (the chat's own, learning-partner `name`). */
  agent: string;
};

type Cursor = { before: number; beforeId: string };
const FILTERS: readonly LaneFilter[] = ["you", "main", "codex", "agy"];
const isFilter = (v: string): v is LaneFilter => (FILTERS as readonly string[]).includes(v);
/** The app's mark, as the chat draws the main lane (DebugEval AGENT_AVATAR). */
const AGENT_AVATAR = "/icon-192.png";

const chip =
  "tap-40 inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm whitespace-nowrap";
const chipOff =
  "border-[oklch(0.85_0.01_260)] dark:border-[oklch(0.4_0.02_260)] hover:bg-[oklch(0.96_0.005_260)] dark:hover:bg-[oklch(0.3_0.02_260)]";
const chipOn =
  "border-transparent bg-[oklch(0.55_0.198_22.3)] text-[oklch(0.99_0_0)] dark:bg-[oklch(0.6_0.176_22.3)]";
const muted = "text-[oklch(0.5_0.01_260)] dark:text-[oklch(0.7_0.01_260)]";
const bad = "text-sm text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]";

function Mark({ line, name }: { line: ChatHistoryLine; name: string }) {
  const box = "size-8 shrink-0 overflow-hidden rounded-full";
  if (line.from !== "agent")
    return (
      <span
        aria-hidden
        className={`${box} flex items-center justify-center bg-[oklch(0.9_0.03_150)] text-sm font-semibold text-[oklch(0.35_0.06_150)] dark:bg-[oklch(0.35_0.05_150)] dark:text-[oklch(0.92_0.03_150)]`}
      >
        {name.slice(0, 1)}
      </span>
    );
  const lane = (line.lane ?? "main") as LaneId;
  const mark = laneAvatar(lane);
  if (mark) return <span className={box}>{mark}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={AGENT_AVATAR} alt="" aria-hidden className={box} />;
}

export default function HistoryClient(p: {
  labels: HistoryLabels;
  locale: string;
  initialQ: string;
  initialLane: string;
}) {
  const L = p.labels;
  const router = useRouter();
  const [q, setQ] = useState(p.initialQ);
  const [lane, setLane] = useState<LaneFilter | "">(isFilter(p.initialLane) ? p.initialLane : "");
  const [delError, setDelError] = useState(false);
  /** The search and filter as last applied (after typing pauses). */
  const [applied, setApplied] = useState({ q: p.initialQ.trim(), lane });

  // No pages (owner, 2026-11-10): older lines load as the list nears its end,
  // from the server's cursor; a search or filter starts over from the newest.
  const list = useInfiniteList<ChatHistoryLine, Cursor>({
    getKey: (l) => l.id,
    deps: [applied.q, applied.lane],
    fetchBatch: async (cursor) => {
      const u = new URLSearchParams();
      if (applied.q) u.set("q", applied.q);
      if (applied.lane) u.set("lane", applied.lane);
      if (cursor) {
        u.set("before", String(cursor.before));
        u.set("beforeId", cursor.beforeId);
      }
      const r = await fetch(`/api/chat/history?${u}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const out = (await r.json()) as { lines: ChatHistoryLine[]; next: Cursor | null };
      return { items: out.lines, next: out.next };
    },
  });
  const lines = list.items;
  const setLines = list.setItems;

  const nameOf = (l: ChatHistoryLine) =>
    l.from !== "agent" ? L.you : LANES[(l.lane ?? "main") as LaneId].name || L.agent;
  const laneName = (f: LaneFilter) => (f === "you" ? L.you : LANES[f].name || L.agent);

  // The search and the filter are in the address (docs/ui-state.md: shareable), and a
  // change reloads from the newest, after typing pauses.
  useEffect(() => {
    const t = setTimeout(
      () => {
        const u = new URLSearchParams();
        if (q.trim()) u.set("q", q.trim());
        if (lane) u.set("lane", lane);
        const s = u.toString();
        router.replace(s ? `/chat/history?${s}` : "/chat/history", { scroll: false });
        setApplied((old) =>
          old.q === q.trim() && old.lane === lane ? old : { q: q.trim(), lane },
        );
      },
      q === p.initialQ ? 0 : 250,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, lane]);

  const remove = async (body: { id: string } | { from: number; to: number }) => {
    setDelError(false);
    try {
      const r = await fetch("/api/chat/history", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok && r.status !== 404) throw new Error(String(r.status));
      setLines((prev) =>
        "id" in body
          ? prev.filter((l) => l.id !== body.id)
          : prev.filter((l) => l.at < body.from || l.at >= body.to),
      );
    } catch {
      setDelError(true);
    }
  };

  const filtered = !!q.trim() || !!lane;
  const rows = dayRows(lines, (l) => l.id);

  return (
    <div className="mx-auto max-w-2xl px-4 pt-6 pb-[calc(6rem+env(safe-area-inset-bottom))]">
      <h1 className="mb-1 text-2xl font-bold">{L.title}</h1>
      <p className={`mb-4 text-sm ${muted}`} data-testid="chat-history-follows">
        {L.follows}
      </p>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={L.search}
        aria-label={L.search}
        maxLength={200}
        data-testid="chat-history-search"
        className="mb-3 w-full rounded-xl border border-[oklch(0.85_0.01_260)] bg-transparent px-3 py-2 text-base dark:border-[oklch(0.4_0.02_260)]"
      />
      <div
        role="group"
        aria-label={L.filterLabel}
        className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1"
      >
        <button
          type="button"
          aria-pressed={!lane}
          className={`${chip} ${!lane ? chipOn : chipOff}`}
          onClick={() => setLane("")}
        >
          {L.all}
        </button>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={lane === f}
            data-testid={`chat-history-lane-${f}`}
            className={`${chip} ${lane === f ? chipOn : chipOff}`}
            onClick={() => setLane(lane === f ? "" : f)}
          >
            {laneName(f)}
          </button>
        ))}
      </div>
      {delError && (
        <p role="alert" className={`mb-3 ${bad}`}>
          {L.deleteFailed}
        </p>
      )}
      {!list.loading && !list.error && lines.length === 0 && (
        <p className={`py-8 text-center ${muted}`} data-testid="chat-history-empty">
          {filtered ? L.noMatch : L.empty}
        </p>
      )}
      <VirtualList
        items={rows}
        getKey={(r) => r.key}
        name="chat-history"
        hasMore={list.hasMore}
        loading={list.loading}
        error={list.error}
        onReachEnd={list.loadMore}
        estimateSize={64}
        label={L.title}
        renderItem={(r) => {
          if (r.kind === "day")
            return (
              <div className="pt-3" data-testid="chat-history-day" data-day={r.day}>
                <div className="-mx-4 mb-2 flex items-center gap-2 bg-[oklch(from_var(--background)_l_c_h/0.8)] px-4 py-1.5 backdrop-blur-md">
                  <h2 className="flex-1 text-sm font-semibold">{longDate(r.first.at, p.locale)}</h2>
                  {!filtered && (
                    <button
                      type="button"
                      data-testid="chat-history-delete-day"
                      className={`tap-40 rounded-full px-2 py-1 text-xs ${muted} hover:text-[oklch(0.58_0.2_27)]`}
                      onClick={() => {
                        const date = longDate(r.first.at, p.locale);
                        const n = String(r.n);
                        if (confirm(L.confirmDay.replace("{date}", date).replace("{n}", n)))
                          void remove(dayRange(r.day));
                      }}
                    >
                      {L.deleteDay}
                    </button>
                  )}
                </div>
              </div>
            );
          const l = r.line;
          const name = nameOf(l);
          return (
            <div className="pb-3">
              <div
                className="group flex gap-3"
                data-testid="chat-history-line"
                data-from={l.from}
                data-lane={l.lane ?? ""}
              >
                <Mark line={l} name={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-semibold">{name}</span>
                    <time
                      dateTime={new Date(l.at).toISOString()}
                      className={`shrink-0 text-xs tabular-nums ${muted}`}
                    >
                      {new Date(l.at).toLocaleTimeString(p.locale, { timeStyle: "short" })}
                    </time>
                    {l.ask && (
                      <span className="shrink-0 rounded-full bg-[oklch(0.62_0.1_80/0.18)] px-1.5 text-xs text-[oklch(0.45_0.1_70)] dark:text-[oklch(0.85_0.1_80)]">
                        {L.askTag}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={L.deleteLine}
                      title={L.deleteLine}
                      data-testid="chat-history-delete-line"
                      className={`tap-40 ms-auto shrink-0 rounded-full px-1.5 text-base leading-none ${muted} hover:text-[oklch(0.58_0.2_27)]`}
                      onClick={() => {
                        if (confirm(L.confirmLine)) void remove({ id: l.id });
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <p className="text-[15px] leading-relaxed break-words whitespace-pre-wrap">
                    {l.from === "agent" ? plainText(l.text) : l.text}
                  </p>
                  {l.answer && (
                    <p className={`mt-0.5 text-sm ${muted}`}>
                      {L.answered.replace("{answer}", l.answer)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
