/**
 * The "录音中 / Recording" badge (clips.ts, clips-store.ts): on every page of
 * a window session while it records, on every origin, with a one-tap Stop.
 * A glass pill at the top of the screen (docs/design-principles.md), out of
 * the layout. It also:
 *
 * - shows how many clips the sink acknowledged ("3 saved"), or "Saving
 *   failed" while the latest post failed (clips-store.ts clipPosted);
 * - holds the screen wake lock while recording (clips-store.ts holdWakeLock)
 *   and says so ("Screen kept on");
 * - carries the session to another of the owner's origins: a tap on a link
 *   there gets the one-time handoff token added just before the browser
 *   follows it; `__lkClips.go(url)` does the same for the agent's eval;
 * - counts down an auto-stop (only when one was asked for) and reminds
 *   CLIPS_REMIND_MS before it;
 * - offers "Continue recording" when another window's recording session lost
 *   its page moments ago (an address typed by hand carries no token). A tap,
 *   never by voice, never by itself.
 */
import { useEffect, useState } from "react";
import { useUi } from "@lianki/ui-state";
import {
  CLIPS_PAUSE_NOTE_MS,
  CLIPS_REMIND_MS,
  handoffHref,
  minutesLeft,
} from "./clips";
import { clipsAction, clipsExpired, clipsLive, holdWakeLock } from "./clips-store";
import type { ChatStrings } from "./wire";

type Strings = Pick<
  ChatStrings,
  | "clipsRecording"
  | "clipsStop"
  | "clipsScreenOn"
  | "clipsScreenMaySleep"
  | "clipsPaused"
  | "clipsStopsIn"
  | "clipsContinue"
  | "clipsSaved"
  | "clipsSaveFailed"
>;

/** Add the handoff token to a same-window link to another owner origin, at the moment it is followed. */
export function installHandoffLinks(doc: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    const to = handoffHref(a.href, location.href, clipsLive().getState().hub?.handoff);
    if (to) a.href = to;
  };
  doc.addEventListener("click", onClick, true);
  const g = globalThis as { __lkClips?: { go(url: string): void } };
  g.__lkClips = {
    go: (url: string) =>
      location.assign(
        handoffHref(url, location.href, clipsLive().getState().hub?.handoff) ?? url,
      ),
  };
  return () => {
    doc.removeEventListener("click", onClick, true);
    if (g.__lkClips) delete g.__lkClips;
  };
}

const n = (s: string, v: number) => s.replaceAll("{n}", String(v));

export function ClipsBadge({ strings }: { strings: Strings }) {
  const store = clipsLive();
  const hub = useUi(store, (s) => s.hub);
  const deadline = useUi(store, (s) => s.deadline);
  const wake = useUi(store, (s) => s.wake);
  const saved = useUi(store, (s) => s.saved);
  const failing = useUi(store, (s) => s.failing);
  const on = !!hub?.on;
  const [now, setNow] = useState(() => Date.now());
  // When the pause note was first shown (it goes after CLIPS_PAUSE_NOTE_MS).
  const [pauseSeen, setPauseSeen] = useState<number | null>(null);

  useEffect(() => installHandoffLinks(), []);
  useEffect(() => (on ? holdWakeLock() : undefined), [on]);
  useEffect(() => setPauseSeen(hub?.paused ? Date.now() : null), [hub?.paused]);

  // One local timeout to the next moment the badge changes: the reminder,
  // the auto-stop, the pause note going. No network, nothing polls.
  useEffect(() => {
    const t = Date.now();
    const next = [
      deadline !== null ? deadline - CLIPS_REMIND_MS : null,
      deadline,
      pauseSeen !== null ? pauseSeen + CLIPS_PAUSE_NOTE_MS : null,
    ].filter((x): x is number => x !== null && x > t);
    if (deadline !== null && deadline - t <= CLIPS_REMIND_MS && deadline > t)
      next.push(t + Math.min(60_000, deadline - t));
    if (!next.length) return;
    const id = setTimeout(
      () => {
        clipsExpired();
        setNow(Date.now());
      },
      Math.min(...next) - t + 20,
    );
    return () => clearTimeout(id);
  }, [deadline, pauseSeen, now]);

  const resumable = !on ? (hub?.resumable ?? []) : [];
  if (!on && !resumable.length) return null;
  const left = deadline !== null ? deadline - now : null;
  /** The second line: the count (recording counts once the sink acknowledged a clip), then notes. */
  const notes: string[] = [];
  if (on && !failing) notes.push(n(strings.clipsSaved, saved));
  if (on && wake === "held") notes.push(strings.clipsScreenOn);
  if (on && (wake === "unsupported" || wake === "failed")) notes.push(strings.clipsScreenMaySleep);
  if (on && left !== null && left <= CLIPS_REMIND_MS && left > 0)
    notes.push(n(strings.clipsStopsIn, minutesLeft(left)));
  if (on && hub?.paused && pauseSeen !== null && now - pauseSeen < CLIPS_PAUSE_NOTE_MS)
    notes.push(n(strings.clipsPaused, Math.max(1, Math.round(hub.paused / 60_000))));
  const red = "oklch(0.62 0.22 27)";

  return (
    <div
      data-testid="clips-badge"
      role="status"
      aria-live="polite"
      data-failing={failing || undefined}
      className="lk-glass pointer-events-auto flex items-center gap-2 rounded-3xl py-1 ps-3 pe-1 text-xs"
      // Layout inline, so it holds before the page's CSS knows these classes (a hot-loaded widget).
      style={{
        position: "fixed",
        insetInline: 0,
        top: "calc(0.25rem + env(safe-area-inset-top))",
        marginInline: "auto",
        width: "fit-content",
        maxWidth: "calc(100vw - 2rem)",
        zIndex: 50,
        border: `1px solid ${failing ? red : "var(--glass-line, oklch(0.5 0 0 / 0.2))"}`,
        color: "var(--foreground, oklch(0.25 0 0))",
      }}
    >
      {on ? (
        <>
          <span
            aria-hidden
            className="inline-block size-2.5 shrink-0 rounded-full motion-safe:animate-pulse"
            style={{ background: red }}
          />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="whitespace-nowrap">
              <span className="font-semibold">{strings.clipsRecording}</span>
              {failing && (
                <span
                  data-testid="clips-badge-failed"
                  className="font-semibold"
                  style={{ color: red }}
                >
                  {" · "}
                  {strings.clipsSaveFailed}
                </span>
              )}
            </span>
            {notes.length > 0 && (
              <span data-testid="clips-badge-note" className="text-[11px] opacity-80">
                {notes.join(" · ")}
              </span>
            )}
          </span>
          <button
            type="button"
            data-testid="clips-stop"
            onClick={() => clipsAction({ type: "clips-off" })}
            className="min-h-10 min-w-10 shrink-0 rounded-full px-3 font-semibold"
            style={{ background: "oklch(0.62 0.22 27 / 0.18)" }}
          >
            {strings.clipsStop}
          </button>
        </>
      ) : (
        resumable.slice(0, 1).map((r) => (
          <button
            key={r.sid}
            type="button"
            data-testid="clips-continue"
            title={r.label}
            onClick={() => clipsAction({ type: "clips-adopt", sid: r.sid })}
            className="min-h-10 rounded-full px-3 font-semibold"
          >
            {strings.clipsContinue}
          </button>
        ))
      )}
    </div>
  );
}
