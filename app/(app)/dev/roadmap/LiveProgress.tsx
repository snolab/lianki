"use client";

/**
 * The "Live" section of /dev/roadmap: what the agents working on Lianki say
 * they are doing, pushed by lianki-push's ProgressHub over a WebSocket
 * (docs/agent-progress.md). Nothing polls: the socket delivers every update,
 * a close or error schedules one reconnect with backoff, and the only timer
 * is a 60 s re-render so "n min ago" stays true.
 */
import { useEffect, useState } from "react";
import {
  type ProgressEntry,
  type ProgressStatus,
  type ProgressView,
  applyProgressMessage,
  parseProgressMessage,
  progressAgo,
} from "@/lib/progress";

const CHIP: Record<ProgressStatus, string> = {
  doing:
    "bg-[oklch(0.93_0.05_250)] text-[oklch(0.4_0.13_250)] dark:bg-[oklch(0.32_0.07_250)] dark:text-[oklch(0.88_0.06_250)]",
  blocked:
    "bg-[oklch(0.93_0.05_25)] text-[oklch(0.45_0.17_25)] dark:bg-[oklch(0.33_0.09_25)] dark:text-[oklch(0.88_0.07_25)]",
  waiting:
    "bg-[oklch(0.93_0.01_80)] text-[oklch(0.42_0.02_80)] dark:bg-[oklch(0.32_0.01_80)] dark:text-[oklch(0.85_0.02_80)]",
  "waiting-owner":
    "bg-[oklch(0.94_0.07_85)] text-[oklch(0.45_0.11_70)] dark:bg-[oklch(0.35_0.07_75)] dark:text-[oklch(0.9_0.08_85)]",
  review:
    "bg-[oklch(0.93_0.05_300)] text-[oklch(0.42_0.14_300)] dark:bg-[oklch(0.33_0.07_300)] dark:text-[oklch(0.88_0.06_300)]",
  done: "bg-[oklch(0.93_0.06_150)] text-[oklch(0.4_0.11_150)] dark:bg-[oklch(0.32_0.06_150)] dark:text-[oklch(0.88_0.07_150)]",
};
const BAR: Record<ProgressStatus, string> = {
  doing: "bg-[oklch(0.6_0.15_250)]",
  blocked: "bg-[oklch(0.6_0.19_25)]",
  waiting: "bg-[oklch(0.6_0.02_80)]",
  "waiting-owner": "bg-[oklch(0.72_0.14_75)]",
  review: "bg-[oklch(0.6_0.15_300)]",
  done: "bg-[oklch(0.62_0.13_150)]",
};

type Conn = "connecting" | "open" | "offline";
/** Reconnect delays: 1 s doubling to 60 s; after this many failures in a row, wait for the network or the tab. */
const MAX_DELAY = 60_000;
const GIVE_UP_AFTER = 10;

export function LiveProgress() {
  const [view, setView] = useState<ProgressView>({ rows: [], log: [] });
  const [conn, setConn] = useState<Conn>("connecting");
  const [now, setNow] = useState(() => Date.now());

  // The one render timer: relative times only, no network.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;

    const connect = () => {
      clearTimeout(retry);
      retry = undefined;
      if (stopped || ws) return;
      setConn("connecting");
      const sock = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/progress`,
      );
      ws = sock;
      sock.onopen = () => {
        failures = 0;
        setConn("open");
      };
      sock.onmessage = (ev) => {
        const msg = parseProgressMessage(ev.data);
        if (msg) setView((v) => applyProgressMessage(v, msg));
      };
      const lost = () => {
        if (ws !== sock) return;
        ws = null;
        setConn("offline");
        if (stopped || ++failures > GIVE_UP_AFTER) return;
        retry = setTimeout(connect, Math.min(MAX_DELAY, 1000 * 2 ** (failures - 1)));
      };
      sock.onclose = lost;
      sock.onerror = () => {
        lost();
        sock.close();
      };
    };
    // Back online, or back to the tab: try now rather than waiting out the backoff.
    const wake = () => {
      if (document.visibilityState !== "visible" || ws) return;
      failures = 0;
      connect();
    };
    connect();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(retry);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      ws?.close();
    };
  }, []);

  const { rows, log } = view;
  return (
    <section className="space-y-3" data-status="live">
      <h2 className="font-antique text-xl flex items-baseline gap-2">
        实时
        <span className="text-sm opacity-50 tabular-nums">{rows.length}</span>
        <span
          className={`ms-auto text-xs font-sans ${conn === "open" ? "text-[oklch(0.55_0.13_150)]" : "opacity-50"}`}
        >
          {conn === "open" ? "● live" : conn === "connecting" ? "connecting…" : "offline"}
        </span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm opacity-50">no live data</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => (
            <Row key={e.id} e={e} now={now} />
          ))}
        </ul>
      )}
      {log.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer opacity-60">log ({log.length})</summary>
          <ol className="mt-2 space-y-1 font-mono text-xs opacity-75">
            {[...log].reverse().map((ev, i) => (
              <li key={`${ev.at}-${i}`} className="break-words">
                <span className="tabular-nums opacity-60">
                  {new Date(ev.at).toISOString().slice(11, 16)}
                </span>{" "}
                {ev.by} · {ev.task} → {ev.status}
                {ev.pct != null && ` ${ev.pct}%`}
                {ev.note && ` — ${ev.note}`}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function Row({ e, now }: { e: ProgressEntry; now: number }) {
  return (
    <li className="rounded-xl border border-black/10 dark:border-white/10 bg-white/60 dark:bg-gray-900/60 px-4 py-3 space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${CHIP[e.status]}`}>
          {e.status}
        </span>
        {e.kind !== "task" && <span className="text-xs opacity-60 shrink-0">{e.kind}</span>}
        <span className="font-medium min-w-0 break-words">{e.task}</span>
        {e.pr != null && (
          <a
            href={`https://github.com/snolab/lianki/pull/${e.pr}`}
            className="text-sm tabular-nums text-blue-600 dark:text-blue-400 hover:underline shrink-0"
            target="_blank"
            rel="noreferrer"
          >
            #{e.pr}
          </a>
        )}
      </div>
      {e.needs && (
        <p className="text-sm">
          <span className="rounded-md px-1.5 py-0.5 text-xs font-medium bg-[oklch(0.94_0.07_85)] text-[oklch(0.45_0.11_70)] dark:bg-[oklch(0.35_0.07_75)] dark:text-[oklch(0.9_0.08_85)]">
            needs you
          </span>{" "}
          {e.needs}
        </p>
      )}
      {e.pct != null && (
        <div
          className="h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"
          role="progressbar"
          aria-valuenow={e.pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={`h-full ${BAR[e.status]}`} style={{ width: `${e.pct}%` }} />
        </div>
      )}
      {e.notes?.length ? (
        <p className="text-sm leading-relaxed opacity-75 break-words">{e.notes.at(-1)!.text}</p>
      ) : null}
      <p className="text-xs opacity-50 flex flex-wrap gap-x-3">
        <span>{e.assignee.name}</span>
        {e.pct != null && <span className="tabular-nums">{e.pct}%</span>}
        {e.eta && <span>ETA {e.eta}</span>}
        <span>updated {progressAgo(e.at, now)}</span>
      </p>
    </li>
  );
}
