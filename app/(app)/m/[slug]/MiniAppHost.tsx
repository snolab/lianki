"use client";

// /m/<slug>'s client side (docs/mini-apps.md): the sandboxed frame, the
// postMessage bridge (lib/mini-apps/bridge.ts) and the permission card.

import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { CAPABILITIES, type CapabilityId } from "@/lib/mini-apps/capabilities";
import {
  createBridge,
  fromFrame,
  parseRequest,
  replyTarget,
  themeEvent,
} from "@/lib/mini-apps/bridge";
import { type Theme, hostTheme, withTheme } from "@/lib/mini-apps/html";
import type { Choice, Grants } from "@/lib/mini-apps/grants";
import type { HostView } from "@/lib/mini-apps/handlers";

type Ask = { cap: CapabilityId; resolve: (c: Choice | null) => void };

export function MiniAppHost({ view }: { view: HostView }) {
  const c = useIntlayer("mini-app");
  const frame = useRef<HTMLIFrameElement>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  // The site's theme (it follows the system): baked into the srcdoc once, then sent as events.
  const [theme, setTheme] = useState<Theme | null>(null);
  const frameOrigin = view.frame.mode === "origin" ? view.frame.origin : "null";

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    setTheme(hostTheme(mq));
    const on = () => {
      const t = hostTheme(mq);
      setTheme(t);
      frame.current?.contentWindow?.postMessage(themeEvent(t), replyTarget(frameOrigin));
    };
    mq?.addEventListener("change", on);
    return () => mq?.removeEventListener("change", on);
  }, [frameOrigin]);
  const first = useRef<Theme | null>(null);
  if (theme && !first.current) first.current = theme;

  useEffect(() => {
    const api = `/api/my/mini-apps/${encodeURIComponent(view.slug)}`;
    const post = async (body: Record<string, unknown>) => {
      const r = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as unknown };
    };
    const bridge = createBridge({
      manifest: {
        slug: view.slug,
        name: view.name,
        icon: view.icon,
        version: view.version,
        permissions: view.permissions,
      },
      grants: () => view.grants,
      prompt: (cap) => new Promise((resolve) => setAsk({ cap, resolve })),
      decide: async (cap, choice) => {
        const r = await post({ action: "decide", permission: cap, choice });
        return ((r.body as { grants?: Grants }).grants ?? {}) as Grants;
      },
      call: (method, args) => post({ action: "call", method, args }),
    });
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!fromFrame(e, win, frameOrigin)) return;
      const req = parseRequest(e.data);
      if (!req) return;
      void bridge.handle(req).then((reply) => win?.postMessage(reply, replyTarget(frameOrigin)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [view, frameOrigin]);

  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function answer(choice: Choice | null) {
    ask?.resolve(choice);
    setAsk(null);
  }

  const f = view.frame;
  return (
    <div className="relative flex min-h-[calc(100dvh-4rem)] flex-col" data-testid="mini-app">
      {first.current && (
        <iframe
          ref={frame}
          title={view.name}
          className="w-full flex-1 border-0"
          style={{ minHeight: "calc(100dvh - 4rem)" }}
          sandbox={f.sandbox}
          referrerPolicy="no-referrer"
          allow=""
          onLoad={() =>
            theme &&
            frame.current?.contentWindow?.postMessage(themeEvent(theme), replyTarget(frameOrigin))
          }
          {...(f.mode === "origin"
            ? { src: f.src }
            : { srcDoc: withTheme(f.srcdoc, first.current) })}
        />
      )}
      {ask && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mini-app-ask"
          data-testid="mini-app-prompt"
          className="absolute inset-x-0 bottom-0 z-[var(--lk-z-overlay,60)] mx-auto mb-[calc(1rem+env(safe-area-inset-bottom))] w-[min(28rem,calc(100%-2rem))] rounded-2xl border border-[oklch(0.5_0.02_70/0.25)] bg-[oklch(0.975_0.012_85/0.92)] p-4 shadow-xl backdrop-blur dark:bg-[oklch(0.23_0.012_65/0.92)]"
        >
          <p id="mini-app-ask" className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="text-2xl">
              {view.icon}
            </span>
            {c.wants.value.replace("{app}", view.name)}
          </p>
          <p className="mt-2">{c[CAPABILITIES[ask.cap].label]}</p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
            <button
              type="button"
              autoFocus
              data-testid="mini-app-allow-app"
              className="min-h-11 rounded-xl bg-primary px-4 font-semibold text-on-primary"
              onClick={() => answer("app")}
            >
              {c.allowApp}
            </button>
            <button
              type="button"
              data-testid="mini-app-allow-once"
              className="min-h-11 rounded-xl border border-[oklch(0.5_0.02_70/0.35)] px-4"
              onClick={() => answer("once")}
            >
              {c.allowOnce}
            </button>
            <button
              type="button"
              data-testid="mini-app-deny"
              className="min-h-11 rounded-xl px-4 underline-offset-4 hover:underline"
              onClick={() => answer("deny")}
            >
              {c.deny}
            </button>
          </div>
          <p className="mt-3 text-xs opacity-70">{c.promptNote}</p>
        </div>
      )}
    </div>
  );
}
