"use client";

import { type ReactNode, createElement, useEffect, useState } from "react";
import { WIDGET_SRC_KEY, eventsUrl, widgetSrc } from "./debug-widget";
import {
  TREE_MAX_BYTES,
  TREE_SRC_KEY,
  type TreeNode,
  sanitizeTree,
  treeClassStyle,
  treeSrc,
} from "./tree-source";

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Sanitized nodes as React elements and text (never HTML). */
function render(nodes: TreeNode[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    if (typeof n === "string") return n;
    const interactive = n.tag === "summary" || n.tag === "li";
    return createElement(
      n.tag,
      {
        key: `${key}${i}`,
        className: [n.cls, interactive ? "pointer-events-auto" : ""].filter(Boolean).join(" ") || undefined,
        style: treeClassStyle(n.cls),
      },
      ...render(n.children, `${key}${i}.`),
    );
  });
}

type TreeState = { nodes: TreeNode[] | null; note: string | null };

/**
 * The interim tree source (tree-source.ts): while `active` (the panel open,
 * no `renderTree`), fetch `lk:tree-src` once, and again on each `tree` event
 * of the hot-load dev server's SSE stream, if the widget is hot-loaded. Null
 * when no source is set.
 */
export function useTreeSource(active: boolean): TreeState | null {
  const [state, setState] = useState<TreeState>({ nodes: null, note: null });
  const [src, setSrc] = useState<URL | null>(null);
  useEffect(() => {
    if (!active) return;
    const raw = read(TREE_SRC_KEY);
    const u = treeSrc(raw);
    setSrc(u);
    if (!u) {
      setState({
        nodes: null,
        note: raw ? `tree source ignored: not https on *.ts.net, nor localhost` : null,
      });
      return;
    }
    const ctl = new AbortController();
    const load = async () => {
      try {
        const r = await fetch(u.href, { cache: "no-store", credentials: "omit", signal: ctl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        if (text.length > TREE_MAX_BYTES) throw new Error("too large");
        setState({ nodes: sanitizeTree(text), note: null });
      } catch (e) {
        if (ctl.signal.aborted) return;
        setState((s) => ({ nodes: s.nodes, note: `tree source failed: ${(e as Error).message}` }));
      }
    };
    void load();
    // Live: the hot-load server's `tree` event (if it ever sends one).
    const hot = widgetSrc(read(WIDGET_SRC_KEY));
    let es: EventSource | null = null;
    if (hot && typeof EventSource !== "undefined") {
      es = new EventSource(eventsUrl(hot));
      es.addEventListener("tree", () => void load());
    }
    return () => {
      ctl.abort();
      es?.close();
    };
  }, [active]);
  return src || state.note ? state : null;
}

/** The fetched tree, as the log shows text; or why there is none. */
export function TreeFragment({ state }: { state: TreeState }) {
  return (
    <div data-testid="debug-chat-tree-fragment">
      {state.note && <p className="text-[10px] text-gray-500">{state.note}</p>}
      {state.nodes ? render(state.nodes) : !state.note && <p className="text-gray-500">Loading the tree…</p>}
    </div>
  );
}
