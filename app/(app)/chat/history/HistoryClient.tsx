"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LANES, type LaneId } from "@lianki/debug-chat/voices";
import { laneAvatar } from "@lianki/debug-chat/LaneMark";
import { longDate } from "@/lib/dates";
import { byDay, dayRange, plainText } from "@/lib/chat-history-view";
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
  const [lines, setLines] = useState<ChatHistoryLine[]>([]);
  const [next, setNext] = useState<Cursor | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "failed">("loading");
  const [delError, setDelError] = useState(false);
  /** Each query's own generation: an older answer never lands over a newer one. */
  const gen = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const nameOf = (l: ChatHistoryLine) =>
    l.from !== "agent" ? L.you : LANES[(l.lane ?? "main") as LaneId].name || L.agent;
  const laneName = (f: LaneFilter) => (f === "you" ? L.you : LANES[f].name || L.agent);

  const load = useCallback(
    async (cursor: Cursor | null) => {
      const g = cursor ? gen.current : ++gen.current;
      setStatus("loading");
      const u = new URLSearchParams();
      if (q.trim()) u.set("q", q.trim());
      if (lane) u.set("lane", lane);
      if (cursor) {
        u.set("before", String(cursor.before));
        u.set("beforeId", cursor.beforeId);
      }
      try {
        const r = await fetch(`/api/chat/history?${u}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const out = (await r.json()) as { lines: ChatHistoryLine[]; next: Cursor | null };
        if (g !== gen.current) return;
        setLines((prev) => (cursor ? [...prev, ...out.lines] : out.lines));
        setNext(out.next);
        setStatus("ok");
      } catch {
        if (g === gen.current) setStatus("failed");
      }
    },
    [q, lane],
  );

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
        void load(null);
      },
      q === p.initialQ ? 0 : 250,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, lane]);

  // More as the end comes into view: no polling, the observer fires on scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next || status !== "ok") return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) void load(next);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [next, status, load]);

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
  const groups = byDay(lines);

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
      {status === "ok" && lines.length === 0 && (
        <p className={`py-8 text-center ${muted}`} data-testid="chat-history-empty">
          {filtered ? L.noMatch : L.empty}
        </p>
      )}
      {groups.map(({ day, lines: ls }) => (
        <section key={day} className="mb-6" data-testid="chat-history-day" data-day={day}>
          <div className="sticky top-0 z-10 -mx-4 mb-2 flex items-center gap-2 bg-[oklch(from_var(--background)_l_c_h/0.8)] px-4 py-1.5 backdrop-blur-md">
            <h2 className="flex-1 text-sm font-semibold">{longDate(ls[0]!.at, p.locale)}</h2>
            {!filtered && (
              <button
                type="button"
                data-testid="chat-history-delete-day"
                className={`tap-40 rounded-full px-2 py-1 text-xs ${muted} hover:text-[oklch(0.58_0.2_27)]`}
                onClick={() => {
                  const date = longDate(ls[0]!.at, p.locale);
                  const n = String(ls.length);
                  if (confirm(L.confirmDay.replace("{date}", date).replace("{n}", n)))
                    void remove(dayRange(day));
                }}
              >
                {L.deleteDay}
              </button>
            )}
          </div>
          <ul className="flex flex-col gap-3">
            {ls.map((l) => {
              const name = nameOf(l);
              return (
                <li
                  key={l.id}
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
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div ref={sentinel} aria-hidden className="h-px" />
      {status === "loading" && (
        <p className={`py-4 text-center text-sm ${muted}`} role="status">
          {L.loading}
        </p>
      )}
      {status === "failed" && (
        <div className="py-6 text-center">
          <p className={`mb-2 ${bad}`}>{L.failed}</p>
          <button
            type="button"
            className={`${chip} ${chipOff}`}
            onClick={() => void load(lines.length ? next : null)}
          >
            {L.retry}
          </button>
        </div>
      )}
    </div>
  );
}
