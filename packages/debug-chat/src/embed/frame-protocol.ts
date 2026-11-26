/**
 * The Learning Partner's frame on other sites (docs/dev-debug-widget.md,
 * "On every site", "The frame"): what the userscript's shell and the
 * lianki.com frame (/embed/partner) say to each other. Typing happens inside
 * the cross-origin frame, so the host page never sees the keys.
 *
 *   frame → parent window  {lk:"partner-frame-up", v}       (to "*": nothing secret)
 *   shell → frame window   {lk:"partner-hello", v, label}   (to the app origin, + a MessagePort)
 *   frame → port           {type:"ready"} | {type:"need-ticket"}
 *   shell → port           {type:"ticket", ticket: string | null}
 *   frame → port           {type:"need-share", what: "selection" | "page"}
 *   shell → port           {type:"share", what, share: SharedPage | null}
 *
 * A share (docs/userscript-li-chat.md, M3) is asked only when he presses
 * Share in the frame's composer; the shell reads the page then, and only
 * then. It goes into the draft or the attachment chip, never out on its own.
 *
 * Only the shell holds a ticket, and it only ever writes one into its own
 * port. The frame sends nothing secret over the port, and typed text goes
 * from the frame straight to the hub. A hostile parent that gets its hello in
 * first can only keep the frame from working (no ticket, no socket); the
 * shell then falls back to read-only.
 */

import { type ShareWhat, type SharedPage, cleanShare, isShareWhat } from "./share";

export const PROTOCOL_V = 1;
export const FRAME_UP = "partner-frame-up";
export const HELLO = "partner-hello";
/** The frame's path on the app origin. */
export const FRAME_PATH = "/embed/partner";
/** After the frame's load event, this long for it to say it is up (ms). */
export const READY_MS = 800;
/** And at most this long overall, if the frame never loads (ms). */
export const LOAD_CAP_MS = 10_000;

/**
 * What a frame can do, said in its "ready" (`caps`). 随身Li opens in the frame
 * only when it says PORTABLE_CAP: an older /embed/partner (a standing notice,
 * no per-account drafts) is not used for it; the bundled window draws instead.
 */
export const PORTABLE_CAP = "portable-v1";

export type PortMsg =
  | { type: "ready"; caps?: string[] }
  | { type: "need-ticket" }
  | { type: "ticket"; ticket: string | null }
  /** The chat's box, px from the frame's bottom-right: the shell sizes the iframe to it. */
  | { type: "size"; w: number; h: number }
  /** He pressed Share in the frame: the shell reads that from the page now. */
  | { type: "need-share"; what: ShareWhat }
  /** The shell's read (share.ts readShare), checked again here; null = nothing to share. */
  | { type: "share"; what: ShareWhat; share: SharedPage | null };

/** The iframe's size bounds (px). */
export const MIN_W = 120;
export const MIN_H = 56;
export const MAX_W = 480;
export const MAX_H = 720;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** The frame's address; `locale` (one of the app's locales) sets its UI language. */
export const frameUrl = (origin: string, locale?: string) =>
  `${origin}${FRAME_PATH}${locale && /^[a-z]{2}$/.test(locale) ? `?lang=${locale}` : ""}`;

type MsgEvent = { source?: unknown; origin?: string; data?: unknown; ports?: readonly unknown[] };

const rec = (d: unknown) => (d && typeof d === "object" ? (d as Record<string, unknown>) : null);

/** The shell's check: this is OUR frame, on the app origin, saying it is up. */
export function isFrameUp(e: MsgEvent, frameWindow: unknown, origin: string): boolean {
  const d = rec(e.data);
  return !!frameWindow && e.source === frameWindow && e.origin === origin && d?.lk === FRAME_UP;
}

/**
 * The frame's check: the parent's hello, with a port. Returns the port, the
 * page label and the parent's origin, or null. `origin` is the browser's
 * `event.origin` of the hello (the window that posted it), never anything in
 * the message: the hub binds a per-site ticket to it (lib/li-thread.ts).
 */
export function helloFrom(
  e: MsgEvent,
  parent: unknown,
): { port: unknown; label: string; origin: string } | null {
  const d = rec(e.data);
  if (!parent || e.source !== parent || d?.lk !== HELLO || !e.ports?.[0]) return null;
  return {
    port: e.ports[0],
    label: typeof d.label === "string" ? d.label.slice(0, 300) : "",
    origin: typeof e.origin === "string" ? e.origin : "",
  };
}

/** A port message, checked. */
export function portMsg(data: unknown): PortMsg | null {
  const d = rec(data);
  if (d?.type === "ready") {
    const caps = Array.isArray(d.caps)
      ? d.caps.filter((c): c is string => typeof c === "string" && c.length <= 32).slice(0, 8)
      : [];
    return caps.length ? { type: "ready", caps } : { type: "ready" };
  }
  if (d?.type === "need-ticket") return { type: d.type };
  if (d?.type === "size" && Number.isFinite(d.w) && Number.isFinite(d.h))
    return {
      type: "size",
      w: clamp(d.w as number, MIN_W, MAX_W),
      h: clamp(d.h as number, MIN_H, MAX_H),
    };
  if (d?.type === "need-share" && isShareWhat(d.what)) return { type: "need-share", what: d.what };
  if (d?.type === "share" && isShareWhat(d.what))
    return { type: "share", what: d.what, share: cleanShare(d.share, d.what) };
  if (d?.type === "ticket")
    return {
      type: "ticket",
      ticket: typeof d.ticket === "string" && d.ticket.length < 1024 ? d.ticket : null,
    };
  return null;
}

/** A CSP report that our frame was refused (frame-src, or child-src as its fallback). */
export function frameBlocked(
  e: { blockedURI?: string; effectiveDirective?: string; violatedDirective?: string },
  origin: string,
): boolean {
  const dir = (e.effectiveDirective || e.violatedDirective || "").split(" ")[0];
  return (
    (dir === "frame-src" || dir === "child-src" || dir === "default-src") &&
    (e.blockedURI ?? "").startsWith(origin)
  );
}
