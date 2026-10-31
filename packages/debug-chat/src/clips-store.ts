/**
 * The page's side of the recording session (clips.ts has the rules), on the
 * UI-state factory (zustand, docs/ui-state.md):
 *
 *   lk:ui:clips          session  this window's session id (`sid`) only; the
 *                                 hub's state, the wake lock and the sender
 *                                 live in memory beside it
 *   lk:pref:clips-device local    this device's id, and whether a tap turns
 *                                 recording on with the auto-stop
 *
 * Both are one instance per page (globalThis), so the hot-loaded widget and
 * the built-in one share them with DebugEval, which owns the socket.
 *
 * A page learns its device id like this: the first page on an origin makes
 * one (random) and keeps it in that origin's localStorage; whenever the hub
 * puts the page in an existing session (a handoff, a reload, a continue), the
 * hub's answer carries that session's device id and the page keeps that one
 * instead. So every origin the window has visited ends up with the same id.
 */
import { createUiStore, type UiStore } from "@lianki/ui-state";
import {
  CLIP_SINK_KEY,
  clipSinkFrom,
  type ClipsPageMessage,
  type ClipsState,
  isClipsId,
  isHandoffToken,
  randomId,
  takeHandoff,
} from "./clips";

export type ClipsWake = "off" | "held" | "unsupported" | "failed";
export type ClipsLive = {
  /** This window's session id (the only field written to sessionStorage). */
  sid: string;
  /** The hub's last word for this session; null before it spoke (or for a friend). */
  hub: ClipsState | null;
  /** The auto-stop on this page's clock (Date.now), from the hub's `left`. */
  deadline: number | null;
  /** The screen wake lock while recording. */
  wake: ClipsWake;
  /** DebugEval's socket, while open. */
  send: ((m: ClipsPageMessage) => boolean) | null;
  /** Clips the sink acknowledged on this page since recording went on. */
  saved: number;
  /** Clips the sink did not keep, and whether the latest post failed (the badge turns to "Saving failed"). */
  failed: number;
  failing: boolean;
};
export type ClipsDevice = { device: string; autoStop: boolean };

const LIVE_INITIAL: ClipsLive = {
  sid: "",
  hub: null,
  deadline: null,
  wake: "off",
  send: null,
  saved: 0,
  failed: 0,
  failing: false,
};

let live: UiStore<ClipsLive> | undefined;
let device: UiStore<ClipsDevice> | undefined;
export const clipsLive = () =>
  (live ??= createUiStore("clips", 1, LIVE_INITIAL, {
    storage: "session",
    keys: ["sid"],
    clean: (s) => {
      const sid = (s as { sid?: unknown } | null)?.sid;
      return isClipsId(sid) ? { sid } : {};
    },
  }));
export const clipsDevice = () =>
  (device ??= createUiStore<ClipsDevice>(
    "clips-device",
    1,
    { device: "", autoStop: false },
    { storage: "local" },
  ));

/** A wake lock that will not release (already gone) is no error. */
const ignore = () => {};

/** A handoff token taken from this page's URL, until the hub has answered once. */
let pendingHandoff: string | null = null;

/**
 * The query the page adds to its hub socket URL: `&ws=<sid>&dev=<device>`,
 * and `&hand=<token>` when it arrived from another origin with one (taken out
 * of the address bar at once, so a reload or a shared link does not carry it).
 */
export function clipsConnectQuery(
  loc: { href: string } = location,
  replace: (url: string) => void = (url) => history.replaceState(history.state, "", url),
): string {
  const s = clipsLive();
  const d = clipsDevice();
  if (!isClipsId(s.getState().sid)) s.setState({ sid: randomId() });
  if (!isClipsId(d.getState().device)) d.setState({ device: randomId() });
  const h = takeHandoff(loc.href);
  if (h) {
    try {
      replace(h.clean);
    } catch {}
    if (isHandoffToken(h.token)) pendingHandoff = h.token;
  }
  const q = new URLSearchParams({ ws: s.getState().sid, dev: d.getState().device });
  if (pendingHandoff) q.set("hand", pendingHandoff);
  return `&${q}`;
}

/** The hub's `clips` message: this window takes the session (and the device id) it names. */
export function onClipsState(msg: unknown, now = Date.now()): boolean {
  const m = msg as ClipsState;
  if (!m || m.type !== "clips" || !isClipsId(m.sid) || !isClipsId(m.device)) return false;
  pendingHandoff = null;
  const was = clipsLive().getState().hub;
  // A new recording (or another session): its counts start again.
  const fresh = m.on && (!was?.on || was.sid !== m.sid || was.since !== m.since);
  clipsLive().setState({
    sid: m.sid,
    hub: m,
    deadline: m.on && typeof m.left === "number" ? now + m.left : null,
    ...(fresh ? { saved: 0, failed: 0, failing: false } : {}),
  });
  if (clipsDevice().getState().device !== m.device) clipsDevice().setState({ device: m.device });
  return true;
}

/**
 * The sink's answer for one clip: counted for the badge ("3 saved", or
 * "Saving failed"), and a failure logged — its status and the sink's host,
 * never the audio or the words.
 */
export function clipPosted(
  r: { ok: true } | { ok: false; status?: number; error: string },
  sink: string,
  log?: (ev: Record<string, unknown>) => void,
) {
  const s = clipsLive();
  if (r.ok) return s.setState({ saved: s.getState().saved + 1, failing: false });
  s.setState({ failed: s.getState().failed + 1, failing: true });
  let host = "";
  try {
    host = new URL(sink).host;
  } catch {}
  log?.({ ev: "clip-post-failed", host, ...(r.status ? { status: r.status } : {}), error: r.error });
}

/** The sink URL this origin offers when a tap turns recording on (lk:debug-clip-sink, read as is). */
export function localClipSink(): string | undefined {
  try {
    return clipSinkFrom(localStorage.getItem(CLIP_SINK_KEY));
  } catch {
    return undefined;
  }
}

/** DebugEval's socket opened (a sender) or closed (null; the hub's state is kept for the badge). */
export function setClipsSender(send: ClipsLive["send"]) {
  clipsLive().setState({ send });
}

/** A tap: on, off, continue another window's session. False when the socket is not open. */
export function clipsAction(m: ClipsPageMessage): boolean {
  return clipsLive().getState().send?.(m) ?? false;
}

/** The deadline passed on this page: stop here at once (the hub stops it too). */
export function clipsExpired(now = Date.now()): boolean {
  const s = clipsLive().getState();
  if (!s.hub?.on || s.deadline === null || now < s.deadline) return false;
  clipsLive().setState({ hub: { ...s.hub, on: false }, deadline: null });
  return true;
}

/**
 * A screen wake lock held while recording, so the screen stays on and the
 * VAD keeps running: requested when recording is on and the page visible,
 * requested again when the page comes back (the system drops it on hide),
 * released when recording stops. Without the API: "unsupported", and the
 * session simply pauses while the screen is off and resumes after.
 */
export function holdWakeLock(
  nav: { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void>; addEventListener?(t: "release", f: () => void): void }> } } = navigator as never,
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
): () => void {
  const s = clipsLive();
  type Lock = { release(): Promise<void> };
  let lock: Lock | null = null;
  let asking = false;
  const want = () => !!s.getState().hub?.on && doc.visibilityState === "visible";
  const set = (wake: ClipsWake) => s.getState().wake !== wake && s.setState({ wake });
  const sync = () => {
    if (!s.getState().hub?.on) {
      const l = lock;
      lock = null;
      void l?.release().catch(ignore);
      return set("off");
    }
    if (!nav.wakeLock) return set("unsupported");
    if (!want() || lock || asking) return;
    asking = true;
    nav.wakeLock.request("screen").then(
      (l) => {
        asking = false;
        if (!s.getState().hub?.on) return void l.release().catch(ignore);
        lock = l;
        set("held");
        l.addEventListener?.("release", () => {
          if (lock !== l) return;
          lock = null;
          // Released by the system (the page hid): asked again once it is visible.
          sync();
        });
      },
      () => {
        asking = false;
        set("failed");
      },
    );
  };
  const unsub = s.subscribe(sync);
  doc.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    unsub();
    doc.removeEventListener("visibilitychange", sync);
    const l = lock;
    lock = null;
    void l?.release().catch(ignore);
  };
}
