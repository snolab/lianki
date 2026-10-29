"use client";

import { useEffect, useRef, useState } from "react";
import { type HubState, type PairInfo, compile, summarize } from "@/lib/dev-eval";
import { DEBUG_EVENT, debugOn, devLog } from "@/lib/debug-client";

/** Hidden this long before the socket is dropped. */
const IDLE_MS = 30_000;
const TOAST_MS = 4_000;

/**
 * Remote eval for the owner's debug session (docs/monitoring.md, "Remote eval
 * (owner debug)"). Only while this device is in debug mode (`lk:debug`) and
 * the page is visible, it holds a WebSocket to lianki-push's
 * /api/version/debug, which accepts it only for the owner's session.
 *
 * A sender (scripts/dev/eval.ts) asking to pair shows up here as a prompt with
 * its label and a short code it prints too; nothing runs unless the owner
 * allows it, for an hour at most, and "End" revokes it. Code it sends arrives
 * as {id, code, to}; it is run here, and the result (or error) goes back over
 * the socket to the sender and to /api/dev/log (Worker logs).
 *
 * A page not in debug mode never opens the socket. Each run shows a toast, and
 * a badge is up while a session is approved, so it is never silent.
 * Reconnects only on events (the socket closing while still visible, coming
 * back to the page, debug turned on) — no timers that touch the network.
 */
export function DebugEval() {
  const [live, setLive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [state, setState] = useState<HubState | null>(null);
  const sockRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    let ws: WebSocket | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let hideToast: ReturnType<typeof setTimeout> | undefined;
    const opened = new WeakSet<WebSocket>();

    const run = async (sock: WebSocket, id: string, to: string, code: string) => {
      clearTimeout(hideToast);
      setToast(`debug eval ran · ${id}`);
      hideToast = setTimeout(() => setToast(null), TOAST_MS);
      const t0 = performance.now();
      let result: Record<string, unknown>;
      try {
        const value = await compile(code)();
        result = { ok: true, ms: Math.round(performance.now() - t0), value: summarize(value) };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        result = {
          ok: false,
          error: `${err.name}: ${err.message}`.slice(0, 1000),
          stack: (err.stack ?? "").slice(0, 2000),
        };
      }
      devLog({ ev: "eval-result", id, ...result });
      try {
        sock.send(JSON.stringify({ type: "result", id, to, ...result }));
      } catch {}
    };

    const connect = () => {
      if (ws) return;
      const standalone = matchMedia?.("(display-mode: standalone)").matches ? "pwa " : "";
      const label = `${location.pathname} ${standalone}${navigator.userAgent}`;
      const sock = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/version/debug?label=${encodeURIComponent(label)}`,
      );
      ws = sock;
      sockRef.current = sock;
      sock.onopen = () => {
        opened.add(sock);
        setLive(true);
        devLog({ ev: "eval-socket", label });
      };
      sock.onmessage = (e) => {
        let msg: { type?: unknown; id?: unknown; to?: unknown; code?: unknown };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (msg.type === "state") {
          setState(msg as HubState);
          return;
        }
        if (msg.type !== "eval") return;
        if (typeof msg.id !== "string" || typeof msg.to !== "string") return;
        if (typeof msg.code !== "string" || !debugOn()) return;
        void run(sock, msg.id, msg.to, msg.code);
      };
      // Dropped by the network: reopen on that event if still wanted. One
      // that never opened was refused (not the owner, or no push service
      // here): leave it until the next visibility or debug event.
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        sockRef.current = null;
        setLive(false);
        setState(null);
        if (opened.has(sock) && wanted()) connect();
      };
    };
    const disconnect = () => {
      clearTimeout(idle);
      const sock = ws;
      ws = null;
      sockRef.current = null;
      setLive(false);
      setState(null);
      sock?.close();
    };
    const wanted = () => document.visibilityState === "visible" && debugOn();
    const update = () => {
      clearTimeout(idle);
      if (wanted()) connect();
      else if (!debugOn()) disconnect();
      else if (ws) idle = setTimeout(disconnect, IDLE_MS);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "lk:debug") update();
    };

    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener(DEBUG_EVENT, update);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener(DEBUG_EVENT, update);
      window.removeEventListener("storage", onStorage);
      clearTimeout(hideToast);
      disconnect();
    };
  }, []);

  const answer = (type: "allow" | "deny" | "revoke", p: PairInfo) => {
    try {
      sockRef.current?.send(JSON.stringify({ type, pair: p.pair }));
    } catch {}
    devLog({ ev: `eval-${type}`, label: p.label, code: p.code });
  };

  const pending = state?.pending ?? null;
  const sessions = state?.sessions ?? [];
  if (!live && !toast) return null;
  return (
    <div
      aria-live="polite"
      data-debug-eval
      className="fixed bottom-2 left-2 z-50 flex max-w-[calc(100vw-1rem)] flex-col items-start gap-1 text-xs"
      style={{ color: "oklch(0.98 0 0)" }}
    >
      {pending && (
        <div
          role="alertdialog"
          aria-label="Remote eval request"
          className="rounded-lg p-3 shadow-lg"
          style={{ background: "oklch(0.28 0.06 30 / 0.97)" }}
        >
          <p className="mb-1">
            <b>{pending.label}</b> wants to run code on your debug pages.
          </p>
          <p className="mb-2">
            Code{" "}
            <b className="font-mono text-sm" style={{ letterSpacing: "0.1em" }}>
              {pending.code}
            </b>{" "}
            — allow only if your terminal shows the same.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => answer("allow", pending)}
              className="rounded px-3 py-1"
              style={{ background: "oklch(0.55 0.15 145)" }}
            >
              Allow for 1 hour
            </button>
            <button
              type="button"
              onClick={() => answer("deny", pending)}
              className="rounded px-3 py-1"
              style={{ background: "oklch(0.45 0.02 260)" }}
            >
              Deny
            </button>
          </div>
        </div>
      )}
      {sessions.map((s) => (
        <div
          key={s.pair}
          className="flex items-center gap-2 rounded-full py-0.5 pl-2 pr-0.5"
          style={{ background: "oklch(0.55 0.15 30 / 0.9)" }}
        >
          <span title={`until ${new Date(s.until ?? 0).toLocaleTimeString()}`}>
            eval: {s.label} · {s.code}
          </span>
          <button
            type="button"
            onClick={() => answer("revoke", s)}
            className="rounded-full px-2"
            style={{ background: "oklch(0.3 0.05 30)" }}
          >
            End
          </button>
        </div>
      ))}
      {toast && (
        <span
          className="pointer-events-none rounded px-2 py-0.5 shadow"
          style={{ background: "oklch(0.25 0.02 260 / 0.9)" }}
        >
          {toast}
        </span>
      )}
    </div>
  );
}
