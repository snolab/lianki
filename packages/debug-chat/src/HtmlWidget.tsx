/**
 * An HTML message widget in its sandboxed frame (html-widget.ts says what the
 * frame may and may not do). The frame reports its height; a reply or a form
 * action fills his reply box, and only messages from this frame count.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { HTML_SANDBOX, actionReply, htmlWidgetDoc, htmlWidgetEvent } from "./html-widget";
import type { WidgetHost } from "./MessageWidget";

const RULE = "light-dark(oklch(0.5 0.01 260 / 0.35), oklch(0.85 0.01 260 / 0.35))";
const MIN_H = 24;

export function HtmlWidget({ html, host }: { html: string; host: WidgetHost }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const maxH = host.htmlMaxHeight ?? 480;
  const [h, setH] = useState(64);
  const dark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const doc = useMemo(() => htmlWidgetDoc(html, dark), [html, dark]);
  const onReply = useRef(host.onReply);
  onReply.current = host.onReply;
  useEffect(() => {
    const on = (e: MessageEvent) => {
      // Only this frame's own messages; its origin is opaque ("null").
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const ev = htmlWidgetEvent(e.data);
      if (!ev) return;
      if (ev.lk === "height") setH(Math.min(maxH, Math.max(MIN_H, ev.h)));
      else if (ev.lk === "reply") onReply.current(ev.text);
      else onReply.current(actionReply(ev));
    };
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, [maxH]);
  return (
    <iframe
      ref={frame}
      data-testid="debug-chat-html-widget"
      title={host.labels.hint}
      sandbox={HTML_SANDBOX}
      srcDoc={doc}
      referrerPolicy="no-referrer"
      loading="lazy"
      className="pointer-events-auto my-1 block w-full max-w-full rounded-lg border"
      style={{ height: h, borderColor: RULE, colorScheme: "normal" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}
