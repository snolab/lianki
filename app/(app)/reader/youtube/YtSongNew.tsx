"use client";

// The new-song form (docs/youtube-song-examples.md, M1): a YouTube link (only
// its video id is kept), timed lyrics pasted or read from a file (LRC, SRT,
// VTT; parsed here to preview, and again on the server), a title. The video
// shows in YouTube's own embed (youtube-nocookie) so he can check it is the
// right one. Saved, the song opens in the reader.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import { YT_HOST } from "@/app/components/yt-clip/yt-api";
import { parseTimedText, videoIdOf, YT_LIMITS } from "@/lib/yt-songs/timed-text";

const field =
  "w-full rounded-lg border border-[oklch(0.8_0.01_250)] bg-transparent px-3 py-2 dark:border-[oklch(0.4_0.01_250)]";

export function YtSongNew() {
  const t = useIntlayer("yt-songs");
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const v = useMemo(() => videoIdOf(url), [url]);
  const parsed = useMemo(() => (lyrics.trim() ? parseTimedText(lyrics) : null), [lyrics]);

  const errText = (code: string): string =>
    ({
      "bad-url": t.badUrl.value,
      empty: t.errNoTimings.value,
      "no-timings": t.errNoTimings.value,
      "too-large": t.errTooLarge.value,
      "too-many-lines": t.errTooLarge.value,
    })[code] ?? t.errFailed.value;

  const readFile = async (f: File) => {
    if (f.size > YT_LIMITS.maxBytes) return setError(t.errTooLarge.value);
    setError("");
    setLyrics(await f.text());
  };

  const save = async () => {
    if (!v) return setError(t.badUrl.value);
    if (!parsed?.ok) return setError(errText(parsed?.error ?? "no-timings"));
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/read/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: v, lyrics, title: title.trim() || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setError(errText(data.error ?? ""));
        return;
      }
      router.push(`/reader/${encodeURIComponent(data.id)}`);
    } catch {
      setError(t.errFailed.value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="yt-song-new">
      <div>
        <Link href="/reader" className="text-sm opacity-70 hover:underline">
          ← {t.back}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t.entry}</h1>
        <p className="mt-2 text-sm opacity-80">{t.intro}</p>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t.urlLabel}</span>
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          className={field}
          data-testid="yt-song-url"
          autoComplete="off"
        />
        {url.trim() && !v && (
          <span className="text-sm text-[oklch(0.5_0.2_25)] dark:text-[oklch(0.78_0.14_25)]">
            {t.badUrl}
          </span>
        )}
      </label>

      {v && (
        // YouTube's own embed, to check the video: visible, with its controls.
        <div className="aspect-video min-h-[200px] w-full overflow-hidden rounded-lg bg-black">
          <iframe
            key={v}
            src={`${YT_HOST}/embed/${v}?playsinline=1&rel=0`}
            title={t.entry.value}
            className="h-full w-full"
            allow="encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            data-testid="yt-song-preview"
          />
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="yt-lyrics" className="text-sm font-medium">
            {t.lyricsLabel}
          </label>
          <label className="cursor-pointer rounded-full px-3 py-1 text-sm text-[oklch(0.45_0.176_22.3)] ring-1 ring-[oklch(0.45_0.176_22.3/0.4)] hover:bg-[oklch(0.5_0.11_22.3/0.1)] dark:text-[oklch(0.8_0.132_22.3)]">
            {t.chooseFile}
            <input
              type="file"
              accept=".lrc,.srt,.vtt,.txt,text/plain,text/vtt"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <textarea
          id="yt-lyrics"
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          rows={10}
          placeholder={"[00:12.30] …\n[00:16.85] …"}
          className={`${field} font-mono text-sm`}
          data-testid="yt-song-lyrics"
          spellCheck={false}
        />
        <p className="text-xs opacity-70">{t.lyricsNote}</p>
        {parsed && (
          <p className="text-sm" data-testid="yt-song-count">
            {parsed.ok ? (
              <>
                {t.linesFound} {parsed.lines.length} ({parsed.format.toUpperCase()})
              </>
            ) : (
              <span className="text-[oklch(0.5_0.2_25)] dark:text-[oklch(0.78_0.14_25)]">
                {errText(parsed.error)}
              </span>
            )}
          </p>
        )}
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t.titleLabel}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={parsed?.ok ? parsed.title : undefined}
          maxLength={300}
          className={field}
          data-testid="yt-song-title"
        />
      </label>

      {error && (
        <p
          className="text-sm text-[oklch(0.5_0.2_25)] dark:text-[oklch(0.78_0.14_25)]"
          role="alert"
        >
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || !v || !parsed?.ok}
        data-testid="yt-song-save"
        className="w-full rounded-lg bg-[oklch(0.5_0.187_22.3)] px-4 py-3 font-medium text-[oklch(0.99_0_0)] disabled:opacity-50"
      >
        {busy ? t.saving : t.save}
      </button>
    </div>
  );
}
