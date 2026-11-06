"use client";

/**
 * /vibe (docs/vibe.md): the consent screen, then the live transcript with an
 * indicator that is always on screen and one tap to pause or stop. The session
 * itself (lib/vibe/session.ts) is built only when Start is tapped, by a real
 * gesture; leaving the page stops it. No sounds at any point.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { VibeWords } from "./VibeWords";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import { vibeBrowserDeps } from "@/lib/vibe/browser";
import {
  createVibeSession,
  type EndReason,
  type PauseReason,
  type VibeView,
} from "@/lib/vibe/session";

export type ConsentText = { heading: string; lines: string[]; rtl: boolean };

const BUTTON =
  "min-h-11 px-5 rounded-lg font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";
const PRIMARY = `${BUTTON} bg-[oklch(0.5_0.16_255)] text-[oklch(0.99_0_0)]`;
const QUIET = `${BUTTON} border border-[oklch(0.7_0_0)] dark:border-[oklch(0.45_0_0)]`;
const DIM = "text-[oklch(0.45_0_0)] dark:text-[oklch(0.72_0_0)]";

function langName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function ConsentBlock({ text, lang, testid }: { text: ConsentText; lang: string; testid: string }) {
  return (
    <section lang={lang} dir={text.rtl ? "rtl" : "ltr"} data-testid={testid}>
      <h2 className="text-xl font-semibold leading-snug mb-2">{text.heading}</h2>
      {text.lines.map((l) => (
        <p key={l} className="leading-relaxed mb-1.5">
          {l}
        </p>
      ))}
    </section>
  );
}

function ConsentScreen({
  locale,
  consent,
  busy,
  onStart,
}: {
  locale: string;
  consent: Record<string, ConsentText>;
  busy: boolean;
  onStart: (otherLang: string) => void;
}) {
  const t = useIntlayer("vibe-page");
  const codes = useMemo(() => Object.keys(consent), [consent]);
  // Not the user's own language to begin with: the point is the other person's.
  const [other, setOther] = useState(() => codes.find((c) => c !== locale) ?? locale);
  const mine = consent[locale] ?? consent.en;
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-[var(--background)] text-[var(--foreground)]"
      style={{ paddingTop: "max(16px, env(safe-area-inset-top))" }}
      role="dialog"
      aria-modal="true"
      aria-label={t.title.value}
      data-testid="vibe-consent"
    >
      <div className="mx-auto flex min-h-full max-w-xl flex-col gap-5 px-4">
        <label className="block text-sm">
          <span className={DIM}>{t.theirLanguage}</span>
          <select
            value={other}
            onChange={(e) => setOther(e.target.value)}
            data-testid="vibe-consent-lang"
            className="mt-1 block w-full min-h-11 rounded-lg border border-[oklch(0.7_0_0)] bg-transparent px-3 dark:border-[oklch(0.45_0_0)]"
          >
            {codes.map((c) => (
              <option key={c} value={c}>
                {langName(c, c)}
              </option>
            ))}
          </select>
        </label>
        <ConsentBlock text={consent[other]} lang={other} testid="vibe-consent-other" />
        {other !== locale && <ConsentBlock text={mine} lang={locale} testid="vibe-consent-mine" />}
        <p className={`text-sm ${DIM}`}>{t.recognised}</p>
        {/* Always on screen, however long the statement runs in this language. */}
        <div
          className="sticky bottom-0 mt-auto flex gap-3 bg-[oklch(from_var(--background)_l_c_h/0.92)] pt-3 backdrop-blur-md"
          style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            className={`${PRIMARY} flex-1`}
            disabled={busy}
            data-testid="vibe-start"
            // A script's click is not his tap (as the voiceprint panel's Agree).
            onClick={(e: MouseEvent) => {
              if (e.isTrusted) onStart(other);
            }}
          >
            {t.start}
          </button>
          <Link
            href="/read"
            className={`${QUIET} flex flex-1 items-center justify-center`}
            data-testid="vibe-cancel"
          >
            {t.cancel}
          </Link>
        </div>
      </div>
    </div>
  );
}

function Indicator({
  view,
  onPause,
  onResume,
  onStop,
}: {
  view: VibeView;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const t = useIntlayer("vibe-page");
  const why: Record<PauseReason, string | null> = {
    user: null,
    hidden: t.whyHidden.value,
    offline: t.whyOffline.value,
    stt: t.whyStt.value,
    mic: t.whyMic.value,
    server: t.whyServer.value,
  };
  const running = view.status === "running";
  return (
    <div
      className="fixed inset-x-0 top-0 z-50 border-b border-[oklch(0.6_0_0/0.3)] bg-[oklch(from_var(--background)_l_c_h/0.85)] px-4 pb-2 backdrop-blur-md"
      style={{ paddingTop: "max(8px, env(safe-area-inset-top))" }}
      data-testid="vibe-indicator"
      data-state={view.status}
    >
      <div className="mx-auto flex max-w-xl items-center gap-2">
        <span
          aria-hidden
          className={`inline-block h-3 w-3 shrink-0 rounded-full ${
            running ? "bg-[oklch(0.6_0.22_25)] motion-safe:animate-pulse" : "bg-[oklch(0.65_0_0)]"
          }`}
        />
        <span className="min-w-0 flex-1 font-medium" role="status" data-testid="vibe-state">
          {view.status === "starting" ? t.starting : running ? t.listening : t.paused}
        </span>
        {running && (
          <button type="button" className={QUIET} onClick={onPause} data-testid="vibe-pause">
            {t.pause}
          </button>
        )}
        {view.status === "paused" && (
          <button type="button" className={QUIET} onClick={onResume} data-testid="vibe-resume">
            {t.resume}
          </button>
        )}
        {view.status !== "starting" && (
          <button type="button" className={QUIET} onClick={onStop} data-testid="vibe-stop">
            {t.stop}
          </button>
        )}
      </div>
      {view.status === "paused" && view.pause && why[view.pause] && (
        <p className={`mx-auto mt-1 max-w-xl text-sm ${DIM}`} data-testid="vibe-why">
          {why[view.pause]}
        </p>
      )}
    </div>
  );
}

function Transcript({ view, locale }: { view: VibeView; locale: string }) {
  const t = useIntlayer("vibe-page");
  return (
    <ol className="flex flex-col gap-3" data-testid="vibe-lines">
      {view.lines.map((l, i) => (
        <li key={i} className="leading-relaxed" data-testid="vibe-line" data-lang={l.lang ?? ""}>
          {l.lang && <span className={`me-2 text-xs ${DIM}`}>{langName(l.lang, locale)}</span>}
          {l.text}
        </li>
      ))}
      {!!view.interim && (
        <li className={`leading-relaxed ${DIM}`} data-testid="vibe-interim">
          {view.interim}
        </li>
      )}
      {!view.lines.length && !view.interim && view.status === "running" && (
        <li className={DIM}>{t.nothingYet}</li>
      )}
      {view.lost > 0 && (
        <li className={`text-sm ${DIM}`} data-testid="vibe-lost">
          {t.lost.value.replaceAll("{n}", String(view.lost))}
        </li>
      )}
    </ol>
  );
}

function EndScreen({ view, onAgain }: { view: VibeView; onAgain: () => void }) {
  const t = useIntlayer("vibe-page");
  const [arm, setArm] = useState(false);
  const [gone, setGone] = useState(false);
  const notes: Partial<Record<EndReason, string>> = {
    refused: t.endRefused.value,
    "consent-required": t.endRefused.value,
    gone: t.endRefused.value,
    "no-stt": t.endNoStt.value,
    "no-mic": t.endNoMic.value,
    full: t.endFull.value,
  };
  const note = view.end ? notes[view.end] : undefined;
  const material = view.material;
  return (
    <div className="mb-6 flex flex-col gap-3" data-testid="vibe-ended">
      <h1 className="text-xl font-semibold">{t.ended}</h1>
      {note && (
        <p className={DIM} data-testid="vibe-end-note">
          {note}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {material && !gone && (
          <Link
            href={`/read/${material}`}
            className={`${PRIMARY} inline-flex items-center`}
            data-testid="vibe-open"
          >
            {t.open}
          </Link>
        )}
        <button type="button" className={QUIET} onClick={onAgain} data-testid="vibe-again">
          {t.again}
        </button>
        {material && !gone && (
          <button
            type="button"
            className={QUIET}
            data-testid="vibe-delete"
            onClick={async () => {
              if (!arm) return setArm(true);
              const r = await fetch(`/api/read/${material}`, { method: "DELETE" }).catch(
                () => null,
              );
              if (r?.ok) setGone(true);
              else setArm(false);
            }}
          >
            {arm ? t.deleteConfirm : t.deleteDoc}
          </button>
        )}
      </div>
      {gone && <p data-testid="vibe-deleted">{t.deleted}</p>}
    </div>
  );
}

export default function VibeClient({
  locale,
  consent,
}: {
  locale: string;
  consent: Record<string, ConsentText>;
}) {
  const t = useIntlayer("vibe-page");
  const [view, setView] = useState<VibeView | null>(null);
  const [opening, setOpening] = useState(false);
  const [tab, setTab] = useState<"text" | "words">("text");
  const session = useRef<ReturnType<typeof createVibeSession> | null>(null);

  // Leaving the page ends it: nothing goes on listening behind another page.
  useEffect(
    () => () => {
      void session.current?.stop();
    },
    [],
  );

  const start = async (otherLang: string) => {
    if (opening) return;
    setOpening(true);
    try {
      // Only now: the mic's code, the Mac's address and the chat's hold are all loaded by this tap.
      const deps = await vibeBrowserDeps();
      const s = createVibeSession({ ...deps, onView: setView });
      session.current = s;
      const when = new Date().toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
      await s.start({
        consent: true,
        otherLang,
        title: t.docTitle.value.replaceAll("{when}", when),
      });
    } finally {
      setOpening(false);
    }
  };

  if (!view || view.status === "idle")
    return <ConsentScreen locale={locale} consent={consent} busy={opening} onStart={start} />;

  return (
    // The transcript never rides on a chat line (packages/debug-chat/src/scene.ts).
    <div
      data-lk-private-screen=""
      className="mx-auto min-h-screen max-w-xl px-4 pb-32"
      style={{ paddingTop: view.status === "stopped" ? 24 : 96 }}
      data-testid="vibe-page"
    >
      {view.status !== "stopped" && (
        <Indicator
          view={view}
          onPause={() => void session.current?.pause()}
          onResume={() => void session.current?.resume()}
          onStop={() => void session.current?.stop()}
        />
      )}
      {view.status === "stopped" && <EndScreen view={view} onAgain={() => setView(null)} />}
      <div className="mb-4 flex gap-2" role="tablist">
        {(["text", "words"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            data-testid={`vibe-tab-${k}`}
            className={`min-h-11 rounded-lg px-4 ${tab === k ? "font-semibold underline underline-offset-4" : DIM}`}
            onClick={() => setTab(k)}
          >
            {k === "text" ? t.tabText : t.tabWords}
          </button>
        ))}
      </div>
      {tab === "text" ? (
        <Transcript view={view} locale={locale} />
      ) : (
        <VibeWords material={view.material} lines={view.lines} locale={locale} />
      )}
    </div>
  );
}
