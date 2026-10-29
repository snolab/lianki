"use client";

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as JsxRuntime from "react/jsx-runtime";
import { Component, type ComponentType, type ReactNode, useEffect, useState } from "react";
import {
  REACT_GLOBAL,
  WIDGET_SRC_KEY,
  eventsUrl,
  failNote,
  loadWidget,
  widgetSrc,
  widgetUrl,
} from "@/lib/debug-widget";
import { DebugChat, type DebugChatProps } from "./DebugChat";

type Chat = ComponentType<DebugChatProps>;
type Hot = { Chat?: Chat; note?: string; rev?: string };
const STYLE_ID = "lk-debug-widget-css";

/**
 * A real dynamic import the bundler leaves alone (the app sets no CSP).
 * Built on first use, in the browser only: Workers refuse code from strings,
 * so doing this at module scope would break server rendering.
 */
const importer = (u: string) =>
  (new Function("u", "return import(u)") as (u: string) => Promise<Record<string, unknown>>)(u);

function setCss(css: string | null) {
  let el = document.getElementById(STYLE_ID);
  if (css === null) return el?.remove();
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.append(el);
  }
  el.textContent = css;
}

/**
 * The widget from `lk:debug-widget-src` (docs/dev-debug-widget.md), while
 * `enabled` (the owner's debug pages only). It holds one EventSource to the
 * dev server and re-imports on each `reload`; any failure leaves Chat unset
 * and says why in `note`.
 */
function useHotWidget(enabled: boolean): [Hot, (e: unknown) => void] {
  const [hot, setHot] = useState<Hot>({});
  useEffect(() => {
    if (!enabled) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(WIDGET_SRC_KEY);
    } catch {}
    if (!raw) return;
    const src = widgetSrc(raw);
    if (!src) {
      setHot({
        note: `dev widget ignored: ${raw.slice(0, 80)} is not https (or http://localhost)`,
      });
      return;
    }
    // The widget's `react` imports read this: the page's own React, so there is one.
    (globalThis as Record<string, unknown>)[REACT_GLOBAL] = { React, jsx: JsxRuntime, ReactDOM };
    let live = true;
    let rev = "";
    const load = (r: string) =>
      loadWidget<Chat>(widgetUrl(src, r), importer).then(
        (m) => {
          if (!live) return;
          setCss(m.css);
          setHot({
            Chat: m.Chat,
            rev: m.rev || r,
            note: `dev widget: ${src.host} · ${m.rev || r || "first"}`,
          });
        },
        (e) => live && setHot({ note: failNote(e) }),
      );
    void load("");
    // One stream, pushed by the dev server; the browser re-opens it if it drops.
    const es = new EventSource(eventsUrl(src));
    const onRev = (e: MessageEvent) => {
      const r = String(e.data);
      if (rev && r !== rev) void load(r);
      rev = r;
    };
    es.addEventListener("hello", onRev);
    es.addEventListener("reload", (e) => {
      rev = String((e as MessageEvent).data);
      void load(rev);
    });
    return () => {
      live = false;
      es.close();
      setCss(null);
      setHot({});
    };
  }, [enabled]);
  return [hot, (e) => setHot((h) => ({ note: failNote(e), rev: h.rev }))];
}

/** A widget that throws while rendering falls back to the built-in chat. */
class Boundary extends Component<{ onError: (e: unknown) => void; children: ReactNode }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    this.props.onError(e);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The debug chat: the built-in DebugChat, or — with `hot` (the owner's pages)
 * and `lk:debug-widget-src` set — the one hot-loaded from a dev server,
 * re-mounted on every rebuild. State lives in props and localStorage, so a
 * re-mount loses nothing.
 */
export function DebugChatHost({ hot, ...props }: DebugChatProps & { hot: boolean }) {
  const [w, fail] = useHotWidget(hot);
  const note = w.note ?? props.note;
  if (!w.Chat) return <DebugChat {...props} note={note} />;
  const Remote = w.Chat;
  return (
    <span data-debug-widget={w.rev || "remote"} className="contents">
      <Boundary key={w.rev} onError={fail}>
        <Remote {...props} note={note} />
      </Boundary>
    </span>
  );
}
