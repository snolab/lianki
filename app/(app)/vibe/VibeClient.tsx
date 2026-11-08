"use client";

/**
 * /vibe (docs/vibe.md): a simple start page, then the live text with an
 * indicator that is always on screen and one tap to pause or stop. The session
 * itself (lib/vibe/session.ts) is built only when Start is tapped, by a real
 * gesture; leaving the page stops it. No sounds at any point.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { useVibeWords } from "./VibeWords";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import { detectLangs } from "@/lib/read/lang-detect";
import { segmentsOf, wordLang } from "@/lib/read/words";
import { askTranslation, vibeBrowserDeps } from "@/lib/vibe/browser";
import {
  createVibeSession,
  type EndReason,
  type PauseReason,
  type VibeLine,
  type VibeView,
} from "@/lib/vibe/session";
import {
  createTranslator,
  readShare,
  type Asked,
  type TranslationRow,
} from "@/lib/vibe/translations";
import { useBookStream } from "../reader/[id]/reader-stream";
import { langName } from "./lang-name";

/** The conversation /vibe/<id> opens on. */
export type VibeDocProps = {
  id: string;
  material: string;
  title: string;
  status: "running" | "paused" | "stopped";
  next: number;
  lines: VibeLine[];
  translations: TranslationRow[];
};

const BUTTON =
  "min-h-11 px-5 rounded-lg font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";
const PRIMARY = `${BUTTON} bg-[oklch(0.5_0.16_255)] text-[oklch(0.99_0_0)]`;
const QUIET = `${BUTTON} border border-[oklch(0.7_0_0)] dark:border-[oklch(0.45_0_0)]`;
const DIM = "text-[oklch(0.45_0_0)] dark:text-[oklch(0.72_0_0)]";

function StartPage({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  const t = useIntlayer("vibe-page");
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 pb-32 pt-6" data-testid="vibe-home">
      <Link href="/vibe" className={`text-sm underline ${DIM}`} data-testid="vibe-all">
        {t.allConversations}
      </Link>
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      <p className="leading-relaxed">{t.intro}</p>
      <button
        type="button"
        className={PRIMARY}
        disabled={busy}
        data-testid="vibe-start"
        // A script's click is not his tap (as the voiceprint panel's Agree).
        onClick={(e: MouseEvent) => {
          if (e.isTrusted) onStart();
        }}
      >
        {t.start}
      </button>
      <p className="leading-relaxed" data-testid="vibe-care">
        {t.yourCare}
      </p>
      <p className={`text-sm ${DIM}`} data-testid="vibe-sent-to-model">
        {t.sentToModel}
      </p>
      <p className={`text-sm ${DIM}`} data-testid="vibe-recognised">
        {t.recognised}
      </p>
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

type Words = ReturnType<typeof useVibeWords>;

const segsOf = (text: string, lang?: string) => segmentsOf(text, wordLang(lang ?? null));

/** A line, every word with the reader's mark, and a tap for its card. Nothing is stored by a tap. */
function Marked({ text, lang, words }: { text: string; lang?: string; words: Words }) {
  const segs = useMemo(() => segsOf(text, lang), [text, lang]);
  return (
    <>
      {segs.map((g, i) => {
        if (!g.word) return g.text;
        const word = g.word;
        const f = words.famOf(word);
        return (
          <button
            key={i}
            type="button"
            className="inline text-start"
            data-testid="vibe-w"
            data-word={word}
            data-f={f === "k" ? undefined : f}
            onClick={() => words.openAt(word, text)}
          >
            {g.text}
          </button>
        );
      })}
    </>
  );
}

function Translated({
  line,
  to,
  state,
  words,
}: {
  line: VibeLine;
  to: string;
  state: Asked | undefined;
  words: Words;
}) {
  const t = useIntlayer("vibe-page");
  if (state === undefined) return null;
  if (state === "asking")
    return (
      <p className={DIM} data-testid="vibe-tr-asking" data-to={to}>
        …
      </p>
    );
  if (state === "failed")
    return (
      <p className={`text-sm ${DIM}`} data-testid="vibe-tr-failed" data-to={to} data-of={line.text}>
        {t.notTranslated}
      </p>
    );
  return (
    <p className="leading-relaxed" lang={to} dir="auto" data-testid="vibe-tr" data-to={to}>
      <Marked text={state} lang={to} words={words} />
    </p>
  );
}

function Transcript({
  view,
  locale,
  translator,
  words,
}: {
  view: VibeView;
  locale: string;
  translator: ReturnType<typeof createTranslator>;
  words: Words;
}) {
  const t = useIntlayer("vibe-page");
  return (
    // lk-book: the reader's own marks (globals.css, data-f).
    <ol className="lk-book flex flex-col gap-3" data-testid="vibe-lines">
      {view.lines.map((l, i) => (
        <li key={i} className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div className="leading-relaxed" data-testid="vibe-line" data-lang={l.lang ?? ""}>
            {l.lang && <span className={`me-2 text-xs ${DIM}`}>{langName(l.lang, locale)}</span>}
            <Marked text={l.text} lang={l.lang} words={words} />
          </div>
          <div data-testid="vibe-translations">
            {translator.shownFor(l).map((to) => (
              <Translated
                key={to}
                line={l}
                to={to}
                state={translator.get(l.text, to)}
                words={words}
              />
            ))}
          </div>
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

function EndScreen({
  view,
  docId,
  busy,
  onContinue,
}: {
  view: VibeView;
  docId: string | null;
  busy: boolean;
  onContinue: () => void;
}) {
  const t = useIntlayer("vibe-page");
  const notes: Partial<Record<EndReason, string>> = {
    refused: t.endRefused.value,
    "not-tapped": t.endRefused.value,
    gone: t.endRefused.value,
    "no-stt": t.endNoStt.value,
    "no-mic": t.endNoMic.value,
    full: t.endFull.value,
  };
  const note = view.end ? notes[view.end] : undefined;
  return (
    <div className="mb-4 flex flex-col items-start gap-3" data-testid="vibe-ended">
      {view.end && <p className="font-medium">{t.ended}</p>}
      {note && (
        <p className={DIM} data-testid="vibe-end-note">
          {note}
        </p>
      )}
      {view.material && docId && (
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          data-testid="vibe-continue"
          // A script's click is not his tap, as on Start.
          onClick={(e: MouseEvent) => {
            if (e.isTrusted) onContinue();
          }}
        >
          {t.keepGoing}
        </button>
      )}
    </div>
  );
}

/** Under the text, so the log is what the page opens on. */
function LogActions({ material, onAgain }: { material: string | null; onAgain: () => void }) {
  const t = useIntlayer("vibe-page");
  const router = useRouter();
  const [arm, setArm] = useState(false);
  return (
    <div className="mt-8 flex flex-wrap gap-3" data-testid="vibe-log-actions">
      {material && (
        <Link
          href={`/reader/${material}`}
          className={`${QUIET} inline-flex items-center`}
          data-testid="vibe-open"
        >
          {t.open}
        </Link>
      )}
      <button type="button" className={QUIET} onClick={onAgain} data-testid="vibe-again">
        {t.again}
      </button>
      {material && (
        <button
          type="button"
          className={QUIET}
          data-testid="vibe-delete"
          onClick={async () => {
            if (!arm) return setArm(true);
            const r = await fetch(`/api/read/${material}`, { method: "DELETE" }).catch(() => null);
            if (r?.ok) router.replace("/vibe");
            else setArm(false);
          }}
        >
          {arm ? t.deleteConfirm : t.deleteDoc}
        </button>
      )}
    </div>
  );
}

const withLangs = (lines: readonly string[]): VibeLine[] => {
  const langs = detectLangs(lines);
  return lines.map((text, i) => ({ text, lang: langs[i] }));
};

export default function VibeClient({ locale, doc }: { locale: string; doc?: VibeDocProps }) {
  const t = useIntlayer("vibe-page");
  const router = useRouter();
  const [view, setView] = useState<VibeView | null>(() =>
    doc
      ? {
          status: "stopped",
          lines: doc.lines,
          interim: "",
          lost: 0,
          material: doc.material,
          doc: doc.id,
        }
      : null,
  );
  const [title, setTitle] = useState(doc?.title ?? "");
  const [opening, setOpening] = useState(false);
  const session = useRef<ReturnType<typeof createVibeSession> | null>(null);
  const [mine, setMine] = useState(false);

  // Leaving the page ends it: nothing goes on listening behind another page.
  useEffect(
    () => () => {
      void session.current?.stop();
    },
    [],
  );

  // Once there is something to come back to, the address is the conversation's.
  // Before the first line there is none: a stop that heard nothing leaves no entry.
  const docId = view?.doc ?? null;
  const hasText = !!view?.material;
  useEffect(() => {
    if (!doc && docId && hasText) window.history.replaceState(null, "", `/vibe/${docId}`);
  }, [doc, docId, hasText]);

  // Another device recording this conversation: follow it, as the reader does.
  const follow = useCallback((m: { lines: string[] }) => {
    setView((v) => (v ? { ...v, lines: withLangs(m.lines) } : v));
  }, []);
  useBookStream<{ lines: string[] }>(
    doc?.material ?? "",
    !!doc && !mine && doc.status !== "stopped",
    follow,
  );

  /** Only now: the mic's code, the Mac's address and the chat's hold are all loaded by this tap. */
  const getSession = async () => {
    setMine(true);
    session.current ??= createVibeSession({ ...(await vibeBrowserDeps()), onView: setView });
    return session.current;
  };

  const start = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const s = await getSession();
      const when = new Date().toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
      const name = t.docTitle.value.replaceAll("{when}", when);
      setTitle(name);
      await s.start({ tap: true, title: name });
    } finally {
      setOpening(false);
    }
  };

  const keepGoing = async () => {
    if (opening || !view?.doc) return;
    setOpening(true);
    try {
      const s = await getSession();
      await s.continueDoc({
        tap: true,
        id: view.doc,
        material: view.material,
        lines: [...view.lines],
        next: s.view().doc === view.doc ? s.sent() : (doc?.next ?? view.lines.length),
      });
    } finally {
      setOpening(false);
    }
  };

  const again = () => {
    if (doc) return router.push("/vibe/new");
    session.current?.reset();
    setView(null);
    setTitle("");
    window.history.replaceState(null, "", "/vibe/new");
  };

  if (!view || view.status === "idle") return <StartPage busy={opening} onStart={start} />;

  return (
    <Conversation
      view={view}
      locale={locale}
      title={title}
      mine={mine}
      known={doc?.translations ?? EMPTY}
      docId={docId}
      opening={opening}
      onPause={() => void session.current?.pause()}
      onResume={() => void session.current?.resume()}
      onStop={() => void session.current?.stop()}
      onContinue={() => void keepGoing()}
      onAgain={again}
    />
  );
}

const EMPTY: TranslationRow[] = [];

function Conversation(p: {
  view: VibeView;
  locale: string;
  title: string;
  mine: boolean;
  known: TranslationRow[];
  docId: string | null;
  opening: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onContinue: () => void;
  onAgain: () => void;
}) {
  const { view, locale, docId } = p;
  const t = useIntlayer("vibe-page");
  const [tab, setTab] = useState<"text" | "words">("text");
  const [version, bump] = useState(0);

  // Sent only by the page recording it (or finishing what it heard), never while
  // paused, and never by opening a log (docs/vibe.md, "Translations").
  const may = useRef({ mine: p.mine, status: view.status, doc: docId });
  may.current = { mine: p.mine, status: view.status, doc: docId };
  const translator = useRef<ReturnType<typeof createTranslator> | null>(null);
  translator.current ??= createTranslator(
    {
      ask: (text, to, from) =>
        may.current.doc ? askTranslation(may.current.doc, text, to, from) : Promise.resolve("wait"),
      canRun: () =>
        may.current.mine && (may.current.status === "running" || may.current.status === "stopped"),
      minPct: readShare,
      onChange: () => bump((n) => n + 1),
    },
    p.known,
  );
  const tr = translator.current;
  useEffect(() => {
    tr.update(view.lines);
  }, [tr, view.lines, view.status, p.mine]);

  const shown = useMemo(() => {
    const out = new Set<string>();
    const add = (text: string, lang?: string) => {
      for (const g of segsOf(text, lang)) if (g.word) out.add(g.word);
    };
    for (const l of view.lines) {
      add(l.text, l.lang);
      for (const to of tr.shownFor(l)) {
        const got = tr.get(l.text, to);
        if (got && got !== "asking" && got !== "failed") add(got, to);
      }
    }
    return [...out];
    // `version` is what says a translation arrived; `tr` itself does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tr, view.lines, version]);
  const words = useVibeWords({ material: view.material, lines: view.lines, locale, shown });

  const langs = useMemo(() => {
    const n = new Map<string, number>();
    for (const l of view.lines) if (l.lang) n.set(l.lang, (n.get(l.lang) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  }, [view.lines]);

  return (
    // The transcript never rides on a chat line (packages/debug-chat/src/scene.ts).
    <div
      data-lk-private-screen=""
      className="mx-auto min-h-screen max-w-xl px-4 pb-32 md:max-w-4xl"
      style={{ paddingTop: view.status === "stopped" ? 24 : 96 }}
      data-testid="vibe-page"
    >
      {view.status !== "stopped" && (
        <Indicator view={view} onPause={p.onPause} onResume={p.onResume} onStop={p.onStop} />
      )}
      <Link href="/vibe" className={`text-sm underline ${DIM}`} data-testid="vibe-all">
        {t.allConversations}
      </Link>
      <h1 className="mb-1 mt-2 text-xl font-semibold" data-testid="vibe-title">
        {p.title}
      </h1>
      {!!langs.length && (
        <p className={`mb-3 text-sm ${DIM}`} data-testid="vibe-langs">
          {langs.map((l) => langName(l, locale)).join(", ")}
        </p>
      )}
      {view.status === "stopped" && (
        <EndScreen view={view} docId={docId} busy={p.opening} onContinue={p.onContinue} />
      )}
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
        <Transcript view={view} locale={locale} translator={tr} words={words} />
      ) : (
        words.list
      )}
      {words.card}
      {view.status === "stopped" && <LogActions material={view.material} onAgain={p.onAgain} />}
    </div>
  );
}
