"use client";

/**
 * /my/recordings (docs/recordings.md): days newest first, more as the reader
 * nears the end (VirtualList, no pages); a day opens to its clips as ONE
 * article — a paragraph per clip, a faint time at each, the speaker/device
 * only where it changes (owner, 2026-11-14 22:4x JST). One shared player:
 * a tap on a paragraph plays its clip (a tap on the playing one pauses), the
 * day plays on clip after clip, and a floating glass bar shows the whole day
 * as one continuous timeline to drag. Nothing plays until tapped. Each
 * paragraph's ⋯ menu: play from here, speed (a device preference), download,
 * copy, delete (asks once, inline). Download day and Delete day stay on the day.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { VirtualList, type VirtualListHandle } from "@/app/components/VirtualList";
import { publicCfg } from "@/lib/config-client";
import {
  type Mark,
  type Paragraph,
  type PlayerState,
  SPEED_KEY,
  locate,
  nextId,
  paragraphs,
  parseSpeeds,
  playTarget,
  positionMs,
  speedFrom,
  totalMs,
  RECORDINGS_EXPANDED_KEY,
  isOtherSpeaker,
  parseExpandedClips,
} from "@/lib/recordings-article";
import {
  type ClipView,
  type DaySummary,
  clock,
  recordingRows,
  withoutClip,
  requestRecordings,
} from "@/lib/recordings-view";
import { safeStorage } from "@lianki/ui-state";

const API = "/api/my/recordings";
const muted = "text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]";
const faint = "text-[oklch(0.55_0_0)] dark:text-[oklch(0.68_0_0)]";
const seal = "text-[oklch(0.5_0.18_25)] dark:text-[oklch(0.78_0.12_25)]";
const sealBg = "bg-[oklch(0.5_0.18_25/0.1)] dark:bg-[oklch(0.78_0.12_25/0.14)]";
const local = safeStorage("local");
const clipUrl = (id: string) => `${API}?clip=${id}`;
/** A drag across clips loads the clip it rests on, not every clip it passes. */
const SCRUB_SETTLE_MS = 120;

type Menu = { day: string; id: string; x: number; y: number };

/** Faint ticks on the timeline where one clip ends and the next begins. */
function ticks(ps: readonly Paragraph[], total: number): string {
  const at = (ms: number) => `${(ms / Math.max(1, total)) * 100}%`;
  const line = "oklch(0.5 0 0 / 0.35)";
  return ps
    .slice(1, 201)
    .map(
      (p) =>
        `linear-gradient(to right, transparent calc(${at(p.startMs)} - 0.5px), ${line} calc(${at(p.startMs)} - 0.5px), ${line} calc(${at(p.startMs)} + 0.5px), transparent calc(${at(p.startMs)} + 0.5px))`,
    )
    .join(",");
}

export default function RecordingsClient() {
  const t = useIntlayer("my-recordings");
  const { locale } = useLocale();
  const [{ days, clips }, setRecordings] = useState({
    days: [] as DaySummary[],
    clips: new Map<string, ClipView[]>(),
  });
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dayErrors, setDayErrors] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState(false);
  const loadingDays = useRef(new Set<string>());
  const [confirm, setConfirm] = useState<string | null>(null);
  const busy = useRef(false);

  // The one player.
  const audio = useRef<HTMLAudioElement | null>(null);
  const list = useRef<VirtualListHandle | null>(null);
  const scrub = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [player, setPlayer] = useState<PlayerState>(null);
  const [pos, setPos] = useState<{ day: string; ms: number } | null>(null);
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Folded "another voice" paragraphs: kept in sessionStorage (docs/ui-state.md).
  const [expandedClips, setExpandedClips] = useState<Set<string>>(() => {
    try {
      return parseExpandedClips(sessionStorage.getItem(RECORDINGS_EXPANDED_KEY));
    } catch {
      return new Set();
    }
  });

  const toggleExpandClip = useCallback((id: string) => {
    setExpandedClips((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        sessionStorage.setItem(RECORDINGS_EXPANDED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);
  const speeds = useMemo(() => parseSpeeds(String(publicCfg("recordings.speeds"))), []);
  const [speed, setSpeedState] = useState(1);
  useEffect(
    () => setSpeedState(speedFrom(local.getItem(SPEED_KEY) as string | null, speeds)),
    [speeds],
  );

  const dayParas = useMemo(() => {
    const m = new Map<string, Paragraph[]>();
    for (const [d, cs] of clips) m.set(d, paragraphs(cs));
    return m;
  }, [clips]);
  // Audio events read the latest values, not the render they were bound in.
  const live = useRef({ player, dayParas, speed });
  live.current = { player, dayParas, speed };

  const loadMore = useCallback(() => {
    if (busy.current || !more) return;
    busy.current = true;
    setLoading(true);
    setError(false);
    const before = days.at(-1)?.day;
    fetch(`${API}${before ? `?before=${before}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((b: { days: DaySummary[]; more: boolean }) => {
        setRecordings((current) => ({
          ...current,
          days: [
            ...current.days,
            ...b.days.filter((x) => !current.days.some((y) => y.day === x.day)),
          ],
        }));
        setMore(b.more);
      })
      .catch(() => setError(true))
      .finally(() => {
        busy.current = false;
        setLoading(false);
      });
  }, [days, more]);

  useEffect(() => {
    loadMore();
    // Once, on mount: VirtualList asks for the rest.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDay = (day: string) => {
    if (loadingDays.current.has(day)) return;
    loadingDays.current.add(day);
    setDayErrors((errors) => {
      const next = new Set(errors);
      next.delete(day);
      return next;
    });
    requestRecordings<{ clips: ClipView[] }>(fetch, `?day=${day}`)
      .then((b) =>
        setRecordings((current) => ({
          ...current,
          clips: new Map(current.clips).set(day, b.clips),
        })),
      )
      .catch(() => setDayErrors((errors) => new Set(errors).add(day)))
      .finally(() => loadingDays.current.delete(day));
  };
  const toggle = (day: string) => {
    const next = new Set(open);
    if (next.has(day)) next.delete(day);
    else {
      next.add(day);
      setLastOpened(day);
      if (!clips.has(day)) loadDay(day);
    }
    setOpen(next);
  };

  /** Stops the player when what it holds is gone (a deleted clip or day). */
  const stopIf = (gone: (p: NonNullable<PlayerState>) => boolean) => {
    const p = live.current.player;
    if (!p || !gone(p)) return;
    const a = audio.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    setPlayer(null);
    setPos(null);
  };

  const delDay = async (day: string) => {
    setConfirm(null);
    setDeleteError(false);
    try {
      await requestRecordings(fetch, `?day=${day}`, "DELETE");
    } catch {
      setDeleteError(true);
      return;
    }
    stopIf((p) => p.day === day);
    setRecordings((current) => {
      const next = new Map(current.clips);
      next.delete(day);
      return { days: current.days.filter((x) => x.day !== day), clips: next };
    });
  };
  const delClip = async (c: ClipView) => {
    setConfirm(null);
    setDeleteError(false);
    try {
      await requestRecordings(fetch, `?clip=${c.id}`, "DELETE");
    } catch {
      setDeleteError(true);
      return;
    }
    stopIf((p) => p.id === c.id);
    // Requests can finish in either order: remove from the latest snapshot.
    setRecordings((current) => withoutClip(current.days, current.clips, c));
  };

  /** Puts a clip in the one player at `fromMs`, and plays it or holds it paused. */
  const cue = (day: string, id: string, fromMs: number, play: boolean, scroll: boolean) => {
    const a = audio.current;
    const p = live.current.dayParas.get(day)?.find((x) => x.c.id === id);
    if (!a || !p) return;
    const seek = () => {
      try {
        a.currentTime = fromMs / 1000;
      } catch {}
    };
    if (live.current.player?.id === id && a.getAttribute("src") === clipUrl(id)) seek();
    else {
      a.src = clipUrl(id);
      a.defaultPlaybackRate = live.current.speed;
      if (fromMs > 0) a.addEventListener("loadedmetadata", seek, { once: true });
      a.load();
    }
    a.playbackRate = live.current.speed;
    setPlayer({ day, id, playing: play });
    setPos({ day, ms: p.startMs + fromMs });
    if (play) a.play().catch(() => setPlayer((s) => (s?.id === id ? { ...s, playing: false } : s)));
    if (scroll) list.current?.scrollToKey(`c:${id}`);
  };

  /** A tap on a paragraph, or "Play from here" (`restart`). */
  const act = (day: string, id: string, restart = false) => {
    const a = audio.current;
    const action = playTarget(live.current.player, { day, id }, restart);
    if (action.do === "pause") a?.pause();
    else if (action.do === "resume") void a?.play().catch(() => {});
    else cue(action.day, action.id, action.fromMs, true, false);
  };

  /** A point of a day's timeline (the bar): the clip there, from that far in. */
  const seekDay = (day: string, ms: number) => {
    const ps = live.current.dayParas.get(day) ?? [];
    const at = locate(ps, ms);
    if (!at) return;
    const id = ps[at.index].c.id;
    const p = live.current.player;
    const playing = !!p?.playing && p.day === day;
    if (scrub.current) clearTimeout(scrub.current);
    scrub.current = null;
    if (p?.id === id) return cue(day, id, at.offsetMs, playing, false);
    setPos({ day, ms });
    scrub.current = setTimeout(() => {
      scrub.current = null;
      cue(day, id, at.offsetMs, playing, true);
    }, SCRUB_SETTLE_MS);
  };

  const setSpeed = (s: number) => {
    setSpeedState(s);
    local.setItem(SPEED_KEY, String(s));
    const a = audio.current;
    if (a) {
      a.defaultPlaybackRate = s;
      a.playbackRate = s;
    }
  };

  // The position moves with the audio, every frame while it plays.
  useEffect(() => {
    if (!player?.playing) return;
    let raf = 0;
    const tick = () => {
      const a = audio.current;
      const p = live.current.dayParas.get(player.day)?.find((x) => x.c.id === player.id);
      if (a && p && !scrub.current) {
        const ms = positionMs(p, a.currentTime);
        setPos((s) => (s && s.day === player.day && s.ms === ms ? s : { day: player.day, ms }));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player]);
  useEffect(() => () => void (scrub.current && clearTimeout(scrub.current)), []);

  /** The day plays on: the next clip when one ends, until the day's last. */
  const onEnded = () => {
    const p = live.current.player;
    if (!p) return;
    const ps = live.current.dayParas.get(p.day) ?? [];
    const next = nextId(ps, p.id);
    if (next) cue(p.day, next, 0, true, true);
    else {
      setPlayer({ ...p, playing: false });
      setPos({ day: p.day, ms: totalMs(ps) });
    }
  };

  // The ⋯ menu closes on Escape or a tap elsewhere; on a scroll it follows its
  // button, and closes once the button has left the window (virtualized away).
  const menuOpen = menu ? `${menu.day}|${menu.id}` : null;
  useEffect(() => {
    if (!menu) return;
    const follow = () => {
      const b = document
        .querySelector(`[data-clip="${menu.id}"] [data-qa="recordings-more"]`)
        ?.getBoundingClientRect();
      if (!b || b.bottom < 0 || b.top > innerHeight) return setMenu(null);
      setMenu((m) => (m && m.id === menu.id ? { ...m, x: b.right, y: b.bottom } : m));
    };
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && (e.target as Element | null)?.closest?.("[data-rec-menu]"))
        return;
      setMenu(null);
      setCopied(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("scroll", follow, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("scroll", follow);
    };
    // Bound per open menu, not per position.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  const dayName = (day: string) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "full",
        timeZone: "UTC",
      }).format(Date.parse(`${day}T00:00:00Z`));
    } catch {
      return day;
    }
  };
  const time = (ms: number) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(ms);
    } catch {
      return new Date(ms).toISOString().slice(11, 16);
    }
  };
  const tz = typeof window === "undefined" ? 0 : new Date().getTimezoneOffset();

  /** "Delete for good?" with Delete / Cancel, in place of the button that asked. */
  const ask = (go: () => void) => (
    <span
      className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm"
      role="group"
      data-qa="recordings-confirm"
    >
      <span>{t.confirm}</span>
      <button
        type="button"
        onClick={go}
        className={`min-h-11 px-2 font-semibold underline ${seal}`}
      >
        {t.confirmYes}
      </button>
      <button type="button" onClick={() => setConfirm(null)} className="min-h-11 px-2 underline">
        {t.cancel}
      </button>
    </span>
  );

  const markText = (m: Mark) =>
    [
      m.speaker === "me" ? t.myVoice.value : m.speaker === "other" ? t.otherVoice.value : null,
      m.device,
    ]
      .filter(Boolean)
      .join(" · ");

  // The bar follows the playing day, else the day last opened.
  const barDay =
    player?.day ??
    (lastOpened && open.has(lastOpened) && dayParas.get(lastOpened)?.length ? lastOpened : null);
  const barParas = barDay ? (dayParas.get(barDay) ?? []) : [];
  const barTotal = totalMs(barParas);
  const barPos = pos && pos.day === barDay ? Math.min(pos.ms, barTotal) : 0;
  const playing = !!player?.playing && player.day === barDay;
  const menuPara = menu ? dayParas.get(menu.day)?.find((p) => p.c.id === menu.id) : undefined;

  return (
    <div
      className={`mx-auto max-w-2xl px-4 py-8 sm:px-8 ${barDay ? "pb-[calc(9rem+var(--lk-bottom-reserve,0px))]" : ""}`}
      data-qa="my-recordings"
    >
      <a href="/my" className="mb-3 inline-flex items-center gap-1 text-sm underline">
        <Icon name="folder" />
        {t.back}
      </a>
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Icon name="microphone" className="shrink-0" />
        <span className="min-w-0 break-words">{t.title}</span>
      </h1>
      <p className={`mt-1 text-sm ${muted}`}>{t.intro}</p>

      {deleteError && (
        <p role="alert" className={seal}>
          {t.deleteFailed}
        </p>
      )}

      {/* The one player: nothing plays until a paragraph or the bar is tapped. */}
      <audio
        ref={audio}
        preload="none"
        className="hidden"
        data-qa="recordings-audio"
        onPlay={() => setPlayer((s) => (s && !s.playing ? { ...s, playing: true } : s))}
        onPause={() => setPlayer((s) => (s && s.playing ? { ...s, playing: false } : s))}
        onEnded={onEnded}
        onError={() => setPlayer((s) => (s && s.playing ? { ...s, playing: false } : s))}
      />

      <VirtualList
        items={recordingRows(days, open, clips, dayErrors)}
        getKey={(r) => r.key}
        name="my-recordings"
        hasMore={more}
        loading={loading}
        error={error}
        onReachEnd={loadMore}
        estimateSize={64}
        label={t.listLabel.value}
        testId="my-recordings-list"
        handle={list}
        empty={
          <p className={`mt-6 text-sm ${muted}`} data-qa="my-recordings-empty">
            {t.empty}
          </p>
        }
        renderItem={(r) => {
          if (r.kind === "day") {
            const { day, clips: n, ms } = r.s;
            return (
              <div
                className="mt-4 flex flex-wrap items-center gap-2 border-b border-[oklch(0.5_0_0/0.2)] pb-2"
                data-qa="recordings-day"
                data-day={day}
              >
                <button
                  type="button"
                  aria-expanded={r.open}
                  onClick={() => toggle(day)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span
                    aria-hidden
                    className={`inline-block transition-transform ${r.open ? "rotate-90" : ""}`}
                  >
                    ▸
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold">{dayName(day)}</span>
                    <span className={`block text-xs ${muted}`}>
                      {t.clips.value.replace("{n}", n.toLocaleString(locale))} · {clock(ms)}
                    </span>
                  </span>
                </button>
                {confirm === `d:${day}` ? (
                  ask(() => void delDay(day))
                ) : (
                  <>
                    <a
                      href={`${API}?day=${day}&archive=zip&tz=${tz}`}
                      download
                      data-qa="recordings-download"
                      className="flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-sm underline"
                    >
                      <Icon name="downloadSimple" />
                      {t.download}
                    </a>
                    <button
                      type="button"
                      data-qa="recordings-delete-day"
                      onClick={() => setConfirm(`d:${day}`)}
                      className={`flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-sm ${seal}`}
                    >
                      <Icon name="trash" />
                      {t.deleteDay}
                    </button>
                  </>
                )}
              </div>
            );
          }
          if (r.kind === "error")
            return (
              <div role="alert" className={`py-3 pl-6 text-sm ${seal}`}>
                <span>{t.loadFailed}</span>{" "}
                <button
                  type="button"
                  className="min-h-11 px-2 underline"
                  onClick={() => loadDay(r.day)}
                >
                  {t.retry}
                </button>
              </div>
            );
          if (r.kind === "loading")
            return <p className={`py-3 pl-6 text-sm ${muted}`}>{t.loading}</p>;
          const { c, p } = r;
          const current = player?.id === c.id;
          const mark = p.mark ? markText(p.mark) : "";
          const isOther = isOtherSpeaker(c.speaker);
          const isFolded = isOther && !expandedClips.has(c.id);

          if (isFolded) {
            return (
              <div
                className={`rounded-lg px-2 py-1.5 ${current ? sealBg : ""}`}
                data-qa="recordings-clip"
                data-clip={c.id}
                data-current={current ? (player?.playing ? "playing" : "paused") : undefined}
                data-folded="other"
              >
                {mark && (
                  <p className={`pt-1 pb-1 text-xs font-medium ${faint}`} data-qa="recordings-mark">
                    {mark}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleExpandClip(c.id)}
                    className="flex min-h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 bg-[oklch(0.5_0_0/0.05)] hover:bg-[oklch(0.5_0_0/0.1)] transition-colors"
                    title={t.otherVoiceFolded.value}
                    data-qa="recordings-folded-other"
                  >
                    <span>{time(c.at)}</span>
                    <span>·</span>
                    <span>{t.otherVoiceFolded.value}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t.more.value}
                    title={t.more.value}
                    aria-haspopup="menu"
                    aria-expanded={menu?.id === c.id}
                    data-qa="recordings-more"
                    data-rec-menu
                    onClick={(e) => {
                      if (menu?.id === c.id) return setMenu(null);
                      const b = e.currentTarget.getBoundingClientRect();
                      setCopied(null);
                      setMenu({ day: c.day, id: c.id, x: b.right, y: b.bottom });
                    }}
                    className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${faint}`}
                  >
                    <Icon name="dotsThree" weight="fill" />
                  </button>
                </div>
              </div>
            );
          }

          return (
            <div
              className={`rounded-lg ${current ? sealBg : ""}`}
              data-qa="recordings-clip"
              data-clip={c.id}
              data-current={current ? (player?.playing ? "playing" : "paused") : undefined}
              data-other-voice={isOther ? "other" : undefined}
            >
              {mark && (
                <p className={`px-2 pt-3 text-xs font-medium ${faint}`} data-qa="recordings-mark">
                  {mark}
                </p>
              )}
              <div className="flex items-start">
                <p
                  role="button"
                  tabIndex={0}
                  aria-current={current || undefined}
                  onClick={() => {
                    // Selecting words to copy them is not a tap.
                    if (String(window.getSelection?.() ?? "")) return;
                    if (isOther && expandedClips.has(c.id)) {
                      toggleExpandClip(c.id);
                      return;
                    }
                    act(c.day, c.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    act(c.day, c.id);
                  }}
                  className="min-w-0 flex-1 cursor-pointer whitespace-pre-wrap break-words px-2 py-1.5 text-base leading-relaxed"
                  data-qa="recordings-text"
                >
                  <span className={`mr-2 select-none text-xs tabular-nums ${faint}`}>
                    {time(c.at)}
                  </span>
                  {c.mode === "passive" && (
                    <span
                      className={`mr-2 select-none rounded border border-current px-1 text-xs ${faint}`}
                    >
                      {t.passive}
                    </span>
                  )}
                  {c.text === null ? (
                    <span className={muted}>{t.unreadable}</span>
                  ) : c.text ? (
                    c.text
                  ) : (
                    <span className={muted}>{t.noText}</span>
                  )}
                </p>
                <button
                  type="button"
                  aria-label={t.more.value}
                  title={t.more.value}
                  aria-haspopup="menu"
                  aria-expanded={menu?.id === c.id}
                  data-qa="recordings-more"
                  data-rec-menu
                  onClick={(e) => {
                    if (menu?.id === c.id) return setMenu(null);
                    const b = e.currentTarget.getBoundingClientRect();
                    setCopied(null);
                    setMenu({ day: c.day, id: c.id, x: b.right, y: b.bottom });
                  }}
                  className={`flex size-11 shrink-0 items-center justify-center rounded-lg ${faint}`}
                >
                  <Icon name="dotsThree" weight="fill" />
                </button>
              </div>
              {confirm === `c:${c.id}` && (
                <div className="px-2 pb-1">{ask(() => void delClip(c))}</div>
              )}
            </div>
          );
        }}
      />

      {menu && menuPara && (
        <div
          role="menu"
          data-rec-menu
          data-qa="recordings-menu"
          className="lk-glass fixed z-40 w-60 max-w-[calc(100vw-2rem)] rounded-xl border border-[oklch(0.5_0_0/0.2)] p-1 text-sm shadow-lg"
          style={{
            top: Math.max(16, Math.min(menu.y + 4, innerHeight - 320)),
            right: Math.max(16, document.documentElement.clientWidth - menu.x),
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-qa="recordings-play-here"
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left"
            onClick={() => {
              setMenu(null);
              act(menu.day, menu.id, true);
            }}
          >
            <Icon name="play" />
            {t.playFromHere}
          </button>
          <div className="px-3 pt-1 pb-1">
            <span className={`text-xs ${muted}`}>{t.speed}</span>
            <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={t.speed.value}>
              {speeds.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s === speed}
                  data-qa="recordings-speed"
                  onClick={() => setSpeed(s)}
                  className={`min-h-11 min-w-11 rounded-lg border px-1 tabular-nums ${
                    s === speed
                      ? "border-[oklch(0.5_0.18_25)] bg-[oklch(0.5_0.18_25)] font-semibold text-[oklch(0.99_0_0)]"
                      : `border-[oklch(0.5_0_0/0.3)] ${muted}`
                  }`}
                >
                  {s.toLocaleString(locale)}×
                </button>
              ))}
            </div>
          </div>
          <a
            role="menuitem"
            href={clipUrl(menu.id)}
            download={`${menu.id}.wav`}
            data-qa="recordings-download-clip"
            onClick={() => setMenu(null)}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3"
          >
            <Icon name="downloadSimple" />
            {t.downloadClip}
          </a>
          <button
            type="button"
            role="menuitem"
            disabled={!menuPara.c.text}
            data-qa="recordings-copy"
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left disabled:opacity-50"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(menuPara.c.text ?? "")
                .then(() => setCopied(menu.id))
                .catch(() => {});
            }}
          >
            <Icon name={copied === menu.id ? "check" : "copy"} />
            {copied === menu.id ? t.copied : t.copyText}
          </button>
          <button
            type="button"
            role="menuitem"
            data-qa="recordings-delete-clip"
            className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left ${seal}`}
            onClick={() => {
              setMenu(null);
              setConfirm(`c:${menu.id}`);
            }}
          >
            <Icon name="trash" />
            {t.deleteClip}
          </button>
        </div>
      )}

      {barDay && barParas.length > 0 && (
        <div
          className="lk-glass fixed inset-x-0 bottom-[var(--lk-bottom-reserve,0px)] z-30 border-t border-[oklch(0.5_0_0/0.2)] px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:left-[var(--nav-w,0px)]"
          data-qa="recordings-bar"
          data-day={barDay}
        >
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <button
              type="button"
              aria-label={playing ? t.pause.value : t.play.value}
              title={playing ? t.pause.value : t.play.value}
              data-qa="recordings-bar-play"
              onClick={() => {
                if (player && player.day === barDay) return act(player.day, player.id);
                const at = locate(barParas, barPos);
                if (at) cue(barDay, barParas[at.index].c.id, at.offsetMs, true, true);
              }}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[oklch(0.5_0.18_25)] text-[oklch(0.99_0_0)]"
            >
              <Icon name={playing ? "pause" : "play"} weight="fill" />
            </button>
            <div className="min-w-0 flex-1">
              <input
                type="range"
                min={0}
                max={Math.max(1, barTotal)}
                step={100}
                value={barPos}
                aria-label={t.timeline.value}
                aria-valuetext={`${clock(barPos)} / ${clock(barTotal)}`}
                data-qa="recordings-timeline"
                onChange={(e) => seekDay(barDay, Number(e.currentTarget.value))}
                className="block h-8 w-full accent-[oklch(0.5_0.18_25)]"
                style={{
                  backgroundImage: ticks(barParas, barTotal),
                  backgroundSize: "100% 6px",
                  backgroundPosition: "center",
                  backgroundRepeat: "no-repeat",
                }}
              />
              <div className={`flex justify-between text-xs tabular-nums ${muted}`}>
                <span data-qa="recordings-bar-pos">{clock(barPos)}</span>
                <span>
                  {speed !== 1 && `${speed.toLocaleString(locale)}× · `}
                  {clock(barTotal)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
