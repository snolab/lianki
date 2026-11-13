/**
 * A new version applies itself on a clean page (docs/ui-state.md, "Unsaved
 * work"): the owner, 2026-11-11 — "这种情况你应该帮我自动刷新". The pill then
 * says so ("New version · updates when idle"), and stays as it was — a tap
 * reloads — while the page holds something a reload would lose ("New version ·
 * unsaved changes").
 *
 * What "clean" is: pageIsDirty(doc, "reload") (lib/page-dirty.ts) — typed text,
 * a focused field, the mic, a voiceprint enrolment, a /words swipe or a /review
 * grade under way — plus the checks this file registers while a version waits:
 * a chat draft not yet sent, anything being read aloud or playing, an open
 * dialog, and a write request still in flight.
 *
 * When: never while the user is mid-action. A clean page reloads when it goes
 * to the background, on the next move to another page, or after a quiet spell
 * with no input (`app.autoUpdateIdleMs`). /words and /review are a session in
 * progress even between cards: there only the first two apply.
 *
 * Off: the flag `app.auto-update` (everyone) or the user's own switch
 * (`lk:auto-update`, /my/preferences; follows the account). Then the pill is
 * the plain "Refresh" button again, as before.
 */
import { notePrefWrite } from "@lianki/ui-state/account";
import { registerDirtyCheck, notifyDirty, type DirtyMode } from "@lianki/ui-state/dirty";

/** The user's own switch: on unless set to "0" (lib/prefs/bindings.ts `app.autoUpdate`). */
export const AUTO_UPDATE_KEY = "lk:auto-update";

/** On unless this device (or the account, synced) turned it off. */
export function autoUpdatePref(store: Pick<Storage, "getItem"> | null = safeLocal()): boolean {
  try {
    return store?.getItem(AUTO_UPDATE_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Turn the switch on or off on this device; the change follows the account. */
export function setAutoUpdatePref(
  on: boolean,
  store: Pick<Storage, "setItem"> | null = safeLocal(),
): void {
  try {
    store?.setItem(AUTO_UPDATE_KEY, on ? "1" : "0");
    notePrefWrite();
  } catch {
    // a private window: for this visit only
  }
}

function safeLocal(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** What the pill says while a new version waits. */
export type UpdateState = "button" | "auto-clean" | "auto-dirty";

/** The pill's state: the plain button when auto-apply is off, else clean or dirty. */
export function updateState(o: { auto: boolean; dirty: boolean }): UpdateState {
  if (!o.auto) return "button";
  return o.dirty ? "auto-dirty" : "auto-clean";
}

/** Auto-apply is on for this page: the flag and the user's switch both say so. */
export function autoUpdateOn(o: { flag: boolean; pref: boolean }): boolean {
  return o.flag && o.pref;
}

/** Why the page might reload now. */
export type ApplyMoment = "hidden" | "navigate" | "idle";

/** Pages that are a session in progress even between actions: no reload while in view. */
const SESSION_ROUTES = ["/words", "/review"];

const inSession = (path: string) =>
  SESSION_ROUTES.some((r) => path === r || path.startsWith(`${r}/`));

/** May a clean page reload at this moment, on this route? */
export function mayApplyAt(moment: ApplyMoment, path: string): boolean {
  if (moment === "idle") return !inSession(path);
  return true;
}

// ── The extra clean signals, registered while a version waits ──

type MediaLike = { paused: boolean; ended: boolean };
type VoiceLike = { state?: () => { speaking?: boolean; queued?: number; hold?: boolean } };
type ElLike = {
  getAttribute(name: string): string | null;
  closest?(selector: string): unknown;
  value?: string;
  textContent?: string | null;
  tagName?: string;
};
export type SignalDoc = {
  querySelectorAll(selector: string): ArrayLike<unknown>;
};

/** Something is being read aloud or playing: a reload would cut it off. */
export function audioPlaying(doc: SignalDoc, g: object = globalThis): boolean {
  const r = g as Record<string, unknown>;
  try {
    const s = (r.speechSynthesis as { speaking?: boolean; pending?: boolean } | undefined) ?? null;
    if (s && (s.speaking || s.pending)) return true;
  } catch {}
  try {
    const v = (r.__lkVoice as VoiceLike | undefined)?.state?.();
    if (v && (v.speaking || (v.queued ?? 0) > 0 || v.hold)) return true;
  } catch {}
  const media = doc.querySelectorAll("audio, video");
  for (let i = 0; i < media.length; i++) {
    const m = media[i] as MediaLike;
    if (!m.paused && !m.ended) return true;
  }
  return false;
}

/** A dialog is open (a modal, a sheet, a confirm): the user is in the middle of something. */
export function dialogOpen(doc: SignalDoc): boolean {
  const els = doc.querySelectorAll(
    'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
  );
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as ElLike;
    if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("hidden") !== null) continue;
    return true;
  }
  return false;
}

/**
 * A chat draft not sent yet. The chat keeps its draft across a reload
 * (`data-dirty="persisted"`, so the leave guard ignores it), but a page that
 * reloads under someone's half-written line is still a surprise.
 */
export function chatDraft(doc: SignalDoc): boolean {
  const els = doc.querySelectorAll(
    '[data-dirty="persisted"] textarea, [data-dirty="persisted"] input',
  );
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as ElLike;
    if ((el.value ?? "").trim() !== "") return true;
  }
  return false;
}

/** Write requests (not GET/HEAD/OPTIONS) to this site still waiting for an answer. */
export type WriteTracker = { inFlight(): number; stop(): void };

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The method and URL of fetch's arguments. */
export function requestOf(
  input: unknown,
  init?: { method?: string },
): { method: string; url: string } {
  const req = input as { method?: string; url?: string } | null;
  const own = typeof input === "object" && req ? req.method : undefined;
  const method = (init?.method ?? own ?? "GET").toUpperCase();
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (req?.url ?? String(input));
  return { method, url };
}

/** A write to this origin (a relative URL counts as this origin). */
export function isOwnWrite(method: string, url: string, origin: string): boolean {
  if (READS.has(method)) return false;
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Count this page's write requests in flight by wrapping `fetch` while a
 * version waits; `stop()` puts the original back. Each finished write
 * notifies the dirty registry, so a page waiting to be clean looks again.
 */
export function trackWrites(g: {
  fetch?: typeof fetch;
  location?: { origin: string };
}): WriteTracker {
  const orig = g.fetch;
  let n = 0;
  if (typeof orig !== "function") return { inFlight: () => 0, stop: () => {} };
  const origin = g.location?.origin ?? "";
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const { method, url } = requestOf(input, init);
    if (!isOwnWrite(method, url, origin)) return orig.call(g, input, init);
    n++;
    const done = () => {
      n--;
      notifyDirty();
    };
    return orig.call(g, input, init).then(
      (res) => (done(), res),
      (e: unknown) => {
        done();
        throw e;
      },
    );
  }) as typeof fetch;
  g.fetch = wrapped;
  return {
    inFlight: () => n,
    stop: () => {
      if (g.fetch === wrapped) g.fetch = orig;
    },
  };
}

/**
 * Register the extra checks (reload mode only) for as long as a version
 * waits; returns their removal. `writes` is a running tracker.
 */
export function registerUpdateChecks(
  doc: SignalDoc,
  writes: WriteTracker,
  g: object = globalThis,
): () => void {
  return registerDirtyCheck(
    (mode: DirtyMode) =>
      mode === "reload" &&
      (writes.inFlight() > 0 || audioPlaying(doc, g) || dialogOpen(doc) || chatDraft(doc)),
  );
}

// ── Where the user was: restored after the reload ──

/** sessionStorage key of the place to come back to after an auto reload. */
export const RESUME_KEY = "lk:auto-update-resume";

export type Resume = { path: string; y: number; anchor?: string; offset?: number };

type AnchorEl = {
  id?: string;
  getAttribute(n: string): string | null;
  getBoundingClientRect(): { top: number };
};

/** A selector for an element by its id or data-testid, or null. */
export function anchorSelector(el: AnchorEl | null): string | null {
  if (!el) return null;
  if (el.id) return `#${CSS_escape(el.id)}`;
  const t = el.getAttribute("data-testid");
  return t ? `[data-testid="${t.replace(/"/g, '\\"')}"]` : null;
}

function CSS_escape(id: string): string {
  const c = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  return c?.escape ? c.escape(id) : id.replace(/[^\w-]/g, (ch) => `\\${ch}`);
}

/** The place to restore, if it was saved for this very path. */
export function resumeFor(raw: string | null, path: string): Resume | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Resume;
    if (r && r.path === path && typeof r.y === "number" && Number.isFinite(r.y)) return r;
  } catch {}
  return null;
}
