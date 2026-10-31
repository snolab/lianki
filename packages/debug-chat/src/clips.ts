/**
 * Voice-clip recording as a window session held by the hub
 * (docs/dev-debug-widget.md, "Voice clips and the STT bench"). Pure rules and
 * wire shapes, shared by the hub (workers/push/src/debug.ts), the page
 * (clips-store.ts) and the agent's CLI (scripts/dev/eval.ts clips).
 *
 * The switch is not in any origin's storage. The hub keeps one short-lived
 * record per recording window session; the page keeps only that session's
 * id, in sessionStorage. When the window moves to another of the owner's
 * origins, a one-time handoff token goes along in the URL (`?lkws=`), and
 * the new origin's page redeems it for the same session.
 *
 * Imports nothing that needs a browser: the hub uses it too.
 */

/** A window session with no page connected ends after this long (a closed window, a navigation that never landed). */
export const CLIPS_GONE_MS = 2 * 60_000;
/** …unless its last page said it was hidden (screen off, app in the background): then this long. */
export const CLIPS_HIDDEN_MS = 12 * 60 * 60_000;
/** The auto-stop when it is turned on (it is off unless asked for). */
export const CLIPS_AUTOSTOP_MIN = 60;
/** The longest auto-stop the hub accepts. */
export const CLIPS_MAX_MIN = 24 * 60;
/** The reminder before an auto-stop. */
export const CLIPS_REMIND_MS = 5 * 60_000;
/** A gap this long shows as "paused N min" in the badge. */
export const CLIPS_PAUSE_NOTE_MS = 60_000;
/** The URL parameter that carries the handoff token to another origin. */
export const HANDOFF_PARAM = "lkws";
/**
 * localStorage on lianki.com and every dev origin: the sink URL a tap offers
 * when it turns recording on (never the switch). Read under this one name
 * only, never through the lk:agent-* alias: a stale alias once won and every
 * clip went to a dead host. Once on, the session's sink (the hub's) is the
 * only one used, on every origin.
 */
export const CLIP_SINK_KEY = "lk:debug-clip-sink";

const ID = /^[A-Za-z0-9_-]{12,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
export const isClipsId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
export const isHandoffToken = (v: unknown): v is string => typeof v === "string" && TOKEN.test(v);

/** A random id (session, device) or token, URL-safe. */
export function randomId(bytes = 12): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The sink URL from a raw value: https, or http on localhost; no trailing slash. */
export function clipSinkFrom(raw: string | null | undefined): string | undefined {
  let u: URL;
  try {
    u = new URL((raw ?? "").trim());
  } catch {
    return undefined;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return undefined;
  return u.href.replace(/\/+$/, "");
}

/**
 * One of the owner's origins, which a recording session may move between:
 * lianki.com, any https tailnet host (the whole-page dev server on :8443, the
 * widget previews), and localhost.
 */
export function isOwnerOrigin(u: URL): boolean {
  if (u.protocol === "https:" && (u.hostname === "lianki.com" || u.hostname.endsWith(".ts.net")))
    return true;
  return (
    (u.protocol === "https:" || u.protocol === "http:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
  );
}

/**
 * The link to follow with the session along: `href` with `?lkws=<token>`,
 * when it goes to another of the owner's origins. Same origin (sessionStorage
 * carries the session there), another site, or no token: null.
 */
export function handoffHref(href: string, here: string, token: string | undefined): string | null {
  if (!token) return null;
  let to: URL;
  let from: URL;
  try {
    from = new URL(here);
    to = new URL(href, from);
  } catch {
    return null;
  }
  if (to.origin === from.origin || !isOwnerOrigin(to)) return null;
  to.searchParams.set(HANDOFF_PARAM, token);
  return to.href;
}

/** A handoff token in this page's URL, and the URL without it (for history.replaceState). */
export function takeHandoff(href: string): { token: string; clean: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const token = u.searchParams.get(HANDOFF_PARAM);
  if (token === null) return null;
  u.searchParams.delete(HANDOFF_PARAM);
  return isHandoffToken(token) ? { token, clean: u.href } : { token: "", clean: u.href };
}

/** What the hub tells each page of a session (on connect, and whenever it changes). */
export type ClipsState = {
  type: "clips";
  /** This window's session id: kept in sessionStorage. */
  sid: string;
  /** The device the session belongs to: kept in localStorage, carried to each origin by the handoff. */
  device: string;
  on: boolean;
  /** Hub time it was turned on. */
  since?: number;
  /** Auto-stop (hub time); absent = until stopped or the session ends. */
  until?: number;
  /** Ms left until `until`, at the hub's now (so the page's clock does not matter). */
  left?: number;
  /** Where the clips go; absent = the page's own CLIP_SINK_KEY. */
  sink?: string;
  /** One-time token for the next cross-origin navigation of this window. */
  handoff?: string;
  /** No page of this session was connected for this long before this one came. */
  paused?: number;
  /** Recording sessions of this owner with no page now, which this page may continue with a tap. */
  resumable?: { sid: string; label: string; since: number }[];
};

/** What a page sends about recording. */
export type ClipsPageMessage =
  | { type: "clips-on"; minutes?: number; sink?: string }
  | { type: "clips-off" }
  | { type: "clips-adopt"; sid: string }
  | { type: "clips-vis"; state: "hidden" | "visible" | "leaving" };

const minutesOf = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.min(Math.round(v), CLIPS_MAX_MIN)
    : undefined;

export function parseClipsPageMessage(m: Record<string, unknown>): ClipsPageMessage | null {
  if (m.type === "clips-on") {
    const minutes = minutesOf(m.minutes);
    const sink = typeof m.sink === "string" ? clipSinkFrom(m.sink) : undefined;
    return { type: "clips-on", ...(minutes ? { minutes } : {}), ...(sink ? { sink } : {}) };
  }
  if (m.type === "clips-off") return { type: "clips-off" };
  if (m.type === "clips-adopt") return isClipsId(m.sid) ? { type: "clips-adopt", sid: m.sid } : null;
  if (m.type === "clips-vis")
    return m.state === "hidden" || m.state === "visible" || m.state === "leaving"
      ? { type: "clips-vis", state: m.state }
      : null;
  return null;
}

/** The agent's request (eval.ts clips): list the sessions, or turn recording on or off. */
export type ClipsControl = {
  type: "clips";
  op: "list" | "on" | "off";
  /** Matches a session id or device id (prefix), or text in one of its pages' labels. */
  match?: string;
  minutes?: number;
  sink?: string;
};

export function parseClipsControl(
  m: Record<string, unknown>,
): { ok: true; value: ClipsControl } | { ok: false; error: string } {
  const op = m.op;
  if (op !== "list" && op !== "on" && op !== "off")
    return { ok: false, error: 'clips needs op "list", "on" or "off"' };
  const match = typeof m.match === "string" ? m.match.trim().slice(0, 120) : "";
  if (op === "on" && !match)
    return { ok: false, error: "clips on needs --device <text>: a device or session id, or text in its page labels" };
  const minutes = m.minutes === undefined ? undefined : minutesOf(m.minutes);
  if (m.minutes !== undefined && !minutes)
    return { ok: false, error: `--minutes must be 1–${CLIPS_MAX_MIN}` };
  const sink = m.sink === undefined ? undefined : clipSinkFrom(String(m.sink));
  if (m.sink !== undefined && !sink)
    return { ok: false, error: "--sink must be an https URL (or http on localhost)" };
  return {
    ok: true,
    value: {
      type: "clips",
      op,
      ...(match ? { match } : {}),
      ...(minutes ? { minutes } : {}),
      ...(sink ? { sink } : {}),
    },
  };
}

/** Does `match` pick this session: its id or device id by prefix, or text in a page label? */
export function matchesSession(
  match: string | undefined,
  s: { sid: string; device: string; labels: string[] },
): boolean {
  if (!match) return true;
  const m = match.toLowerCase();
  if (s.sid.toLowerCase().startsWith(m) || s.device.toLowerCase().startsWith(m)) return true;
  return s.labels.some((l) => l.toLowerCase().includes(m));
}

/**
 * The sink this page posts to now: the session's own (the hub's), only
 * while it records. One source of truth: no origin's key can override it.
 */
export function activeSink(
  state: Pick<ClipsState, "on" | "sink"> | null | undefined,
): string | undefined {
  return state?.on ? clipSinkFrom(state.sink) : undefined;
}

/** Whole minutes for the badge, at least 1. */
export const minutesLeft = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
