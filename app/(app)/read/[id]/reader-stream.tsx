"use client";

/**
 * /read/<id>?streamingFrom=google-docs (docs/connections.md, "Live stream"):
 * lianki-push brings each live edit, shown at once as the tail under the book
 * (only the new words are cut and looked up), and says when the book was saved;
 * then the book is fetched and the tail keeps only what it does not hold yet.
 * Nothing polls. The Reader stays mounted, so the place on the page is kept;
 * someone already at the end follows the new text down.
 */
import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import {
  EMPTY_TAIL,
  applyTailOps,
  unsavedTail,
  type Tail,
  type TailOp,
} from "@/lib/read/gdoc-tail";
import { learningBand, type Fam } from "@/lib/read/reader-model";
import { segmentsOf } from "@/lib/read/words";

export type StreamState = "connecting" | "live" | "offline";

const atEnd = () =>
  window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;

const followDown = (follow: boolean) => {
  if (follow)
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
};

export function useBookStream<M extends { lines: string[] }>(
  id: string,
  on: boolean,
  setMaterial: (m: M) => void,
): { state: StreamState; tail: string } {
  const [state, setState] = useState<StreamState>("connecting");
  const [tail, setTail] = useState("");
  const tailRef = useRef<Tail>(EMPTY_TAIL);
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    let fetching = false;
    let again = false;
    const refetch = async () => {
      if (fetching) {
        again = true;
        return;
      }
      fetching = true;
      try {
        const follow = atEnd();
        const res = await fetch(`/api/read/${id}`);
        if (res.ok && !stopped) {
          const m = (await res.json()) as M;
          setMaterial(m);
          const text = unsavedTail(m.lines.slice(-200).join("\n"), tailRef.current.text);
          tailRef.current = { ...tailRef.current, text };
          setTail(text);
          followDown(follow);
        }
      } catch (err) {
        console.error("read: live text failed to load", err);
      }
      fetching = false;
      if (again && !stopped) {
        again = false;
        void refetch();
      }
    };
    const connect = () => {
      setState((s) => (s === "live" ? "offline" : s));
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/read-stream?book=${encodeURIComponent(id)}`,
      );
      ws.onopen = () => {
        // Anything said while this socket was away is caught up on here.
        if (tries > 0) void refetch();
        tries = 0;
        setState("live");
      };
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(String(e.data)) as { book?: string; ops?: TailOp[] };
          if (d.book !== id) return;
          if (!d.ops) return void refetch();
          const follow = atEnd();
          tailRef.current = applyTailOps(tailRef.current, d.ops);
          setTail(tailRef.current.text);
          followDown(follow);
        } catch {}
      };
      ws.onclose = () => {
        if (stopped) return;
        setState("offline");
        tries++;
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(tries, 5)));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [id, on, setMaterial]);
  return { state, tail };
}

type Hits = Record<string, [number, 0 | 1]>;

/**
 * The text not saved yet, under the book. Words keep their span as the tail
 * grows, so only new ones mount (and flash), and only words not asked about
 * before go to /api/words/familiarity.
 */
export function LiveTail({ text, lang }: { text: string; lang: string }) {
  const [fam, setFam] = useState<Map<string, Fam>>(() => new Map());
  const asked = useRef(new Set<string>());
  const paras = text.split("\n").filter((p) => p.trim());
  const segs = paras.map((p) => segmentsOf(p, lang));
  const fresh = [
    ...new Set(segs.flat().flatMap((g) => (g.word && !asked.current.has(g.word) ? [g.word] : []))),
  ];
  const wanted = fresh.join("\n");
  useEffect(() => {
    if (!wanted) return;
    const words = wanted.split("\n").slice(0, 600);
    for (const w of words) asked.current.add(w);
    fetch("/api/words/familiarity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lang, words }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ hits: Hits }>) : null))
      .then((d) => {
        if (!d) return;
        setFam((prev) => {
          const next = new Map(prev);
          for (const w of words) {
            const h = d.hits[w];
            next.set(w, !h ? "u" : h[1] ? "k" : learningBand(h[0]));
          }
          return next;
        });
      })
      .catch(() => {});
  }, [wanted, lang]);
  if (!paras.length) return null;
  return (
    <div className="lk-book mx-auto w-full max-w-[38em] px-5" data-testid="read-live-tail">
      {segs.map((row, i) => (
        <p key={i} className="mb-4">
          {row.map((g, j) => {
            const f = g.word ? fam.get(g.word) : undefined;
            return (
              <span key={j} className="lk-live-new" data-f={f && f !== "k" ? f : undefined}>
                {g.text}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}

export function StreamBadge({ state }: { state: StreamState }) {
  const t = useIntlayer("read-gdoc-stream");
  return (
    <p
      className="fixed left-1/2 top-2 z-40 -translate-x-1/2 rounded-full bg-base-200/80 px-3 py-1 text-xs backdrop-blur"
      data-testid="read-stream-badge"
      data-state={state}
    >
      {state === "live" ? t.live : t.offline}
    </p>
  );
}
