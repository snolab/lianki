"use client";

/**
 * /read/<id>?streamingFrom=google-docs (docs/connections.md, "Live stream"):
 * lianki-push says when the book has new text, and the reader fetches it.
 * Nothing polls. The Reader stays mounted, so the place on the page is kept;
 * someone already at the end follows the new text down.
 */
import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";

export type StreamState = "connecting" | "live" | "offline";

const atEnd = () =>
  window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;

export function useBookStream<M>(
  id: string,
  on: boolean,
  setMaterial: (m: M) => void,
): StreamState {
  const [state, setState] = useState<StreamState>("connecting");
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
          setMaterial((await res.json()) as M);
          if (follow)
            requestAnimationFrame(() =>
              window.scrollTo({ top: document.documentElement.scrollHeight }),
            );
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
          if ((JSON.parse(String(e.data)) as { book?: string }).book === id) void refetch();
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
  return state;
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
