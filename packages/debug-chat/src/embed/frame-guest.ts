/**
 * The frame's side of the handshake (/embed/partner on lianki.com; see
 * frame-protocol.ts). Says it is up to its parent, takes the FIRST hello
 * that carries a port, says ready on that port, and asks it for a ticket
 * each time it connects. Nothing secret ever goes out on the port.
 */
import { FRAME_UP, PROTOCOL_V, helloFrom, portMsg } from "./frame-protocol";

export type PortLike = {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  start?(): void;
  close?(): void;
};

type WinLike = {
  parent: { postMessage(m: unknown, target: string): void } | null;
  addEventListener(t: "message", f: (e: MessageEvent) => void): void;
  removeEventListener(t: "message", f: (e: MessageEvent) => void): void;
};

export type Guest = {
  /** A fresh ticket from the shell, or null (none, or no answer in `waitMs`). */
  ticket(): Promise<string | null>;
  label: string;
  /** Tell the shell how big the chat is (it sizes the iframe; the page keeps its clicks elsewhere). */
  size(w: number, h: number): void;
};

export function startFrameGuest(
  win: WinLike,
  onGuest: (g: Guest) => void,
  waitMs = 8000,
): () => void {
  let taken = false;
  let port: PortLike | null = null;
  const waiting: ((t: string | null) => void)[] = [];
  const onMessage = (e: MessageEvent) => {
    if (taken) return;
    const h = helloFrom(e, win.parent);
    if (!h) return;
    taken = true;
    port = h.port as PortLike;
    port.onmessage = (m) => {
      const msg = portMsg(m.data);
      if (msg?.type === "ticket") waiting.shift()?.(msg.ticket);
    };
    port.start?.();
    port.postMessage({ type: "ready" });
    onGuest({
      label: h.label,
      size: (w, hh) => port?.postMessage({ type: "size", w, h: hh }),
      ticket: () =>
        new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            const i = waiting.indexOf(done);
            if (i > -1) waiting.splice(i, 1);
            resolve(null);
          }, waitMs);
          const done = (t: string | null) => {
            clearTimeout(timer);
            resolve(t);
          };
          waiting.push(done);
          port?.postMessage({ type: "need-ticket" });
        }),
    });
  };
  win.addEventListener("message", onMessage);
  // Up: to "*" — the parent is any site; the message holds nothing.
  win.parent?.postMessage({ lk: FRAME_UP, v: PROTOCOL_V }, "*");
  return () => {
    win.removeEventListener("message", onMessage);
    port?.close?.();
  };
}
