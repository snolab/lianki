"use client";
/**
 * The /words first-visit walkthrough (lib/words/onboarding.ts): a circled "?"
 * right after the page heading, and the short animated dialog it opens. On a
 * first visit the dialog opens by itself; Skip, ✕ or "Got it" fold it into the
 * "?" and remember that on the account. With animations off (the app's setting
 * or the system's reduced motion) each scene is one still frame, stepped with
 * Back / Next. Colours: seal-ink red and gold on paper / ink, oklch only.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntlayer } from "next-intlayer";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import { useMotionOff } from "@/lib/motion-pref";
import {
  autoShow,
  deviceSynced,
  markSeen,
  nextScene,
  ONBOARDING_CONFIG,
  prevScene,
  readSeen,
  SCENES,
  type Scene,
} from "@/lib/words/onboarding";

export default function WordsOnboarding() {
  const text = useIntlayer("words-onboarding");
  const grades = useIntlayer("words-page");
  const still = useMotionOff();
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState(0);
  const [fold, setFold] = useState<string | null>(null);
  const [pulse, setPulse] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // First visit: open by itself, unless the account already says "seen". A
  // device that never synced waits a moment for the account's answer.
  useEffect(() => {
    if (!autoShow({ flagOn: true, seen: readSeen() })) return;
    const show = () => {
      if (!autoShow({ flagOn: true, seen: readSeen() })) return;
      setScene(0);
      setOpen(true);
    };
    if (deviceSynced()) return show();
    const t = setTimeout(show, ONBOARDING_CONFIG.firstSyncGraceMs);
    // Seen on another device, applied while waiting: stays shut.
    const applied = () => readSeen() && clearTimeout(t);
    window.addEventListener(PREF_APPLIED_EVENT, applied);
    return () => {
      clearTimeout(t);
      window.removeEventListener(PREF_APPLIED_EVENT, applied);
    };
  }, []);

  // With motion, the scenes play on by themselves (a manual step restarts the clock).
  useEffect(() => {
    if (!open || still || fold) return;
    const n = nextScene(scene);
    if (n === null) return;
    const t = setTimeout(() => setScene(n), ONBOARDING_CONFIG.sceneMs);
    return () => clearTimeout(t);
  }, [open, still, fold, scene]);

  const close = useCallback(() => {
    markSeen();
    const b = btn.current?.getBoundingClientRect();
    const d = box.current?.getBoundingClientRect();
    const done = () => {
      setOpen(false);
      setFold(null);
      setPulse(true);
      btn.current?.focus({ preventScroll: true });
    };
    if (still || !b || !d) return done();
    // Shrink into the "?": move the dialog's centre onto the button's.
    const dx = b.left + b.width / 2 - (d.left + d.width / 2);
    const dy = b.top + b.height / 2 - (d.top + d.height / 2);
    setFold(`translate(${dx}px, ${dy}px) scale(${Math.max(0.04, b.width / d.width)})`);
    setTimeout(done, ONBOARDING_CONFIG.foldMs);
  }, [still]);

  useEffect(() => {
    if (!open) return;
    box.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") setScene((i) => nextScene(i) ?? i);
      else if (e.key === "ArrowLeft") setScene(prevScene);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, close]);

  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(false), 900);
    return () => clearTimeout(t);
  }, [pulse]);

  const last = nextScene(scene) === null;
  const id: Scene = SCENES[scene];
  const label = text.help.value;

  return (
    <>
      <button
        ref={btn}
        type="button"
        data-words-onboarding-help
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        onClick={() => {
          setScene(0);
          setOpen(true);
        }}
        className="lk-ob-help -my-2.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full"
        data-pulse={pulse ? "" : undefined}
      >
        <span
          aria-hidden
          className="inline-flex size-6 items-center justify-center rounded-full text-sm font-semibold"
        >
          ?
        </span>
      </button>
      {open &&
        createPortal(
          <div className="lk-ob fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
            <div
              className="lk-ob-shade absolute inset-0"
              style={{ opacity: fold ? 0 : undefined }}
              onClick={close}
            />
            <div
              ref={box}
              role="dialog"
              aria-modal="true"
              aria-label={label}
              tabIndex={-1}
              data-words-onboarding
              data-scene={id}
              data-static={still ? "" : undefined}
              className="lk-ob-box relative w-full max-w-sm rounded-2xl p-4 outline-none"
              style={
                fold
                  ? {
                      transform: fold,
                      opacity: 0.15,
                      transition: `transform ${ONBOARDING_CONFIG.foldMs}ms cubic-bezier(.5,0,.75,0), opacity ${ONBOARDING_CONFIG.foldMs}ms`,
                    }
                  : undefined
              }
            >
              <button
                type="button"
                data-words-onboarding-close
                aria-label={text.close.value}
                onClick={close}
                className="lk-ob-ghost absolute right-1 top-1 inline-flex size-11 items-center justify-center rounded-full text-lg"
              >
                ✕
              </button>
              <div className="pt-6">
                <SceneArt
                  key={id + (still ? "-s" : "")}
                  scene={id}
                  grades={[
                    grades.again.value,
                    grades.hard.value,
                    grades.good.value,
                    grades.easy.value,
                  ]}
                />
              </div>
              <p
                aria-live="polite"
                data-words-onboarding-caption
                className="lk-ob-ink mt-3 min-h-[3em] text-center text-base leading-snug"
              >
                {text[id].value}
              </p>
              <div className="mt-2 flex justify-center gap-1.5" aria-hidden>
                {SCENES.map((s, i) => (
                  <span
                    key={s}
                    className="lk-ob-dot size-1.5 rounded-full"
                    data-on={i === scene ? "" : undefined}
                  />
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  data-words-onboarding-skip
                  onClick={close}
                  className="lk-ob-ghost min-h-11 rounded-lg px-3 text-sm"
                >
                  {text.skip.value}
                </button>
                <span className="flex-1" />
                {scene > 0 && (
                  <button
                    type="button"
                    data-words-onboarding-back
                    onClick={() => setScene(prevScene)}
                    className="lk-ob-ghost min-h-11 rounded-lg px-3 text-sm"
                  >
                    {text.back.value}
                  </button>
                )}
                <button
                  type="button"
                  data-words-onboarding-next
                  onClick={() => (last ? close() : setScene((i) => nextScene(i) ?? i))}
                  className="lk-ob-seal min-h-11 rounded-lg px-4 text-sm font-semibold"
                >
                  {last ? text.done.value : text.next.value}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      <style>{CSS}</style>
    </>
  );
}

/* ---- the scenes: one SVG each. Every element's resting style is the scene's
   last frame, and its animation runs from the start into it, so with
   animations off the still frame says the same thing. ---- */

const W = 300;
const H = 190;

/** A word card: the word as a bar, and (shown) the answer's two lines. */
function Card({
  x,
  y,
  w = 220,
  h = 40,
  answer = false,
  cls = "",
  children,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  answer?: boolean;
  cls?: string;
  children?: ReactNode;
}) {
  return (
    <g className={cls}>
      <rect x={x} y={y} width={w} height={h} rx={8} className="ob-card" />
      <rect x={x + 14} y={y + 12} width={w * 0.32} height={9} rx={4} className="ob-word" />
      {answer && (
        <g className="ob-answer">
          <rect x={x + 14} y={y + 28} width={w * 0.6} height={5} rx={2.5} className="ob-line" />
          <rect x={x + 14} y={y + 38} width={w * 0.42} height={5} rx={2.5} className="ob-line" />
        </g>
      )}
      {children}
    </g>
  );
}

const Finger = ({ cx, cy, cls }: { cx: number; cy: number; cls: string }) => (
  <g className={cls}>
    <circle cx={cx} cy={cy} r={13} className="ob-finger" />
    <circle cx={cx} cy={cy} r={5} className="ob-finger-dot" />
  </g>
);

function SceneArt({ scene, grades }: { scene: Scene; grades: string[] }) {
  let art: ReactNode = null;
  if (scene === "tap") {
    art = (
      <>
        <Card x={40} y={45} h={70} answer />
        <circle cx={150} cy={80} r={28} className="ob-ripple" />
        <Finger cx={150} cy={80} cls="ob-tap" />
      </>
    );
  } else if (scene === "rate") {
    art = (
      <>
        <Card x={40} y={18} h={60} answer />
        {grades.map((g, i) => (
          <g key={g} className="ob-grade" style={{ animationDelay: `${0.3 + i * 0.35}s` }}>
            <rect
              x={18 + i * 68}
              y={100}
              width={60}
              height={52}
              rx={9}
              className={i === 2 ? "ob-btn ob-btn-pick" : "ob-btn"}
            />
            <text
              x={48 + i * 68}
              y={122}
              textAnchor="middle"
              className={i === 2 ? "ob-t ob-t-on" : "ob-t"}
            >
              {g}
            </text>
            <text
              x={48 + i * 68}
              y={140}
              textAnchor="middle"
              className={i === 2 ? "ob-s ob-t-on" : "ob-s"}
            >
              …
            </text>
          </g>
        ))}
        <Finger cx={184} cy={128} cls="ob-press" />
      </>
    );
  } else if (scene === "handled") {
    art = (
      <g className="ob-scroll">
        <Card x={40} y={40} cls="ob-faded">
          <circle cx={243} cy={60} r={9} className="ob-stamp" />
          <path d="M 296 52 a 8 8 0 1 0 2 10" className="ob-undo" />
          <path d="M 292 48 l 4 4 l -5 3" className="ob-undo" />
        </Card>
        <Card x={40} y={88} />
        <Card x={40} y={136} />
        <Card x={40} y={184} />
      </g>
    );
  } else if (scene === "returns") {
    art = (
      <>
        <Card x={40} y={6} cls="ob-faded-still" />
        <Card x={40} y={54} cls="ob-faded-still" />
        <Card x={40} y={102} />
        <g className="ob-return">
          <Card x={40} y={146} cls="ob-again" />
          <text x={250} y={170} textAnchor="end" className="ob-s ob-gold-t">
            …
          </text>
        </g>
      </>
    );
  } else {
    art = (
      <>
        <g className="ob-grow">
          <Card x={30} y={20} w={190} h={44} answer />
          <Card x={30} y={72} w={190} h={44} answer />
          <Card x={30} y={124} w={190} h={44} answer />
        </g>
        <Finger cx={258} cy={55} cls="ob-pinch-a" />
        <Finger cx={258} cy={135} cls="ob-pinch-b" />
        <path d="M 258 76 V 114" className="ob-arrow" />
      </>
    );
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="lk-ob-art block w-full" role="img" aria-hidden>
      <rect x={0} y={0} width={W} height={H} rx={12} className="ob-bg" />
      {art}
    </svg>
  );
}

const CSS = `
.lk-ob, .lk-ob-help {
  --ob-paper: oklch(0.975 0.008 85);
  --ob-surface: oklch(0.995 0.003 85);
  --ob-card: oklch(1 0 0);
  --ob-ink: oklch(0.22 0.012 30);
  --ob-mute: oklch(0.5 0.012 30);
  --ob-line: oklch(0.86 0.01 80);
  --ob-seal: oklch(0.53 0.207 22.3);
  --ob-on-seal: oklch(0.99 0.005 85);
  --ob-gold: oklch(0.76 0.14 80);
  --ob-gold-soft: oklch(0.93 0.06 88);
  --ob-faded: oklch(0.93 0.004 80);
  --ob-shade: oklch(0.15 0.01 30 / 0.45);
}
@media (prefers-color-scheme: dark) {
  .lk-ob, .lk-ob-help {
    --ob-paper: oklch(0.2 0.01 30);
    --ob-surface: oklch(0.24 0.01 30);
    --ob-card: oklch(0.3 0.012 30);
    --ob-ink: oklch(0.95 0.008 85);
    --ob-mute: oklch(0.75 0.01 85);
    --ob-line: oklch(0.48 0.012 30);
    --ob-seal: oklch(0.66 0.19 24);
    --ob-on-seal: oklch(0.16 0.01 30);
    --ob-gold: oklch(0.82 0.13 85);
    --ob-gold-soft: oklch(0.38 0.07 80);
    --ob-faded: oklch(0.25 0.006 30);
    --ob-shade: oklch(0.05 0.005 30 / 0.6);
  }
}
.lk-ob-help { color: var(--ob-seal); }
.lk-ob-help > span { border: 1.5px solid currentColor; }
.lk-ob-help:hover > span, .lk-ob-help:focus-visible > span { background: var(--ob-seal); color: var(--ob-on-seal); }
.lk-ob-help[data-pulse] > span { animation: ob-pulse 0.9s ease-out; }
@keyframes ob-pulse { 0% { transform: scale(1.6); background: var(--ob-gold); } 100% { transform: scale(1); } }
.lk-ob-shade { background: var(--ob-shade); transition: opacity 0.3s; }
.lk-ob-box { background: var(--ob-surface); color: var(--ob-ink); box-shadow: 0 12px 40px oklch(0.1 0.01 30 / 0.35); transform-origin: center; }
.lk-ob-ink { color: var(--ob-ink); }
.lk-ob-ghost { color: var(--ob-mute); }
.lk-ob-ghost:hover { color: var(--ob-ink); }
.lk-ob-seal { background: var(--ob-seal); color: var(--ob-on-seal); }
.lk-ob-dot { background: var(--ob-line); }
.lk-ob-dot[data-on] { background: var(--ob-seal); }

.lk-ob-art .ob-bg { fill: var(--ob-paper); }
.lk-ob-art .ob-card { fill: var(--ob-card); stroke: var(--ob-line); stroke-width: 1; }
.lk-ob-art .ob-word { fill: var(--ob-ink); }
.lk-ob-art .ob-line { fill: var(--ob-mute); opacity: 0.6; }
.lk-ob-art .ob-finger { fill: var(--ob-gold); opacity: 0.55; }
.lk-ob-art .ob-finger-dot { fill: var(--ob-gold); }
.lk-ob-art .ob-ripple { fill: none; stroke: var(--ob-gold); stroke-width: 2; opacity: 0; }
.lk-ob-art .ob-btn { fill: var(--ob-gold-soft); stroke: var(--ob-gold); stroke-width: 1.5; }
.lk-ob-art .ob-btn-pick { fill: var(--ob-seal); stroke: var(--ob-seal); }
.lk-ob-art .ob-t { font: 600 11px system-ui, sans-serif; fill: var(--ob-ink); }
.lk-ob-art .ob-s { font: 600 13px system-ui, sans-serif; fill: var(--ob-mute); }
.lk-ob-art .ob-t-on { fill: var(--ob-on-seal); }
.lk-ob-art .ob-gold-t { fill: var(--ob-gold); }
.lk-ob-art .ob-faded, .lk-ob-art .ob-faded-still { opacity: 0.5; }
.lk-ob-art .ob-faded .ob-card, .lk-ob-art .ob-faded-still .ob-card { fill: var(--ob-faded); }
.lk-ob-art .ob-stamp { fill: none; stroke: var(--ob-seal); stroke-width: 2.5; }
.lk-ob-art .ob-undo { fill: none; stroke: var(--ob-seal); stroke-width: 2; stroke-linecap: round; transform: translateX(-30px); }
.lk-ob-art .ob-again .ob-card { stroke: var(--ob-gold); stroke-width: 2.5; }
.lk-ob-art .ob-arrow { stroke: var(--ob-gold); stroke-width: 2; stroke-dasharray: 3 4; }
.lk-ob-art .ob-scroll { transform: translateY(-30px); }
.lk-ob-art .ob-grow { transform-box: fill-box; transform-origin: 50% 0; transform: scaleY(1); }

/* Motion: each runs once from the scene's start into its resting frame. */
.lk-ob-box:not([data-static]) .ob-tap { animation: ob-tap 1.6s ease-in-out both; }
.lk-ob-box:not([data-static]) .ob-ripple { animation: ob-ripple 0.8s ease-out 0.9s both; }
.lk-ob-box[data-scene="tap"]:not([data-static]) .ob-answer { animation: ob-in 0.5s ease-out 1.1s both; }
.lk-ob-box:not([data-static]) .ob-grade { animation: ob-light 0.45s ease-out both; }
.lk-ob-box:not([data-static]) .ob-btn-pick { animation: ob-pick 0.3s ease-out 2.6s both; }
.lk-ob-box:not([data-static]) .ob-t-on { animation: ob-pick-t 0.3s ease-out 2.6s both; }
.lk-ob-box:not([data-static]) .ob-press { animation: ob-press 1.4s ease-in-out 1.7s both; }
.lk-ob-box:not([data-static]) .ob-faded { animation: ob-fade 0.6s ease-out 0.4s both; }
.lk-ob-box:not([data-static]) .ob-scroll { animation: ob-scroll 0.9s cubic-bezier(.3,0,.2,1) 1.4s both; }
.lk-ob-box:not([data-static]) .ob-undo { animation: ob-in 0.4s ease-out 2.4s both; }
.lk-ob-box:not([data-static]) .ob-return { animation: ob-return 0.9s cubic-bezier(.2,.8,.3,1) 0.8s both; }
.lk-ob-box:not([data-static]) .ob-grow { animation: ob-grow 2.4s ease-in-out 0.5s both; }
.lk-ob-box:not([data-static]) .ob-pinch-a { animation: ob-pinch-a 2.4s ease-in-out 0.5s both; }
.lk-ob-box:not([data-static]) .ob-pinch-b { animation: ob-pinch-b 2.4s ease-in-out 0.5s both; }
.lk-ob-box[data-static] *, html[data-motion="off"] .lk-ob * { animation: none !important; transition: none !important; }

@keyframes ob-in { from { opacity: 0; } }
@keyframes ob-tap {
  0% { transform: translate(90px, 90px); opacity: 0; }
  45% { transform: translate(0, 0); opacity: 1; }
  55% { transform: scale(0.9); transform-origin: 150px 80px; }
  70% { transform: translate(0, 0); }
  100% { transform: translate(60px, 70px); opacity: 0; }
}
@keyframes ob-ripple { 0% { opacity: 0.9; transform: scale(0.3); transform-origin: 150px 80px; } 100% { opacity: 0; transform: scale(1.2); transform-origin: 150px 80px; } }
@keyframes ob-light { from { opacity: 0.25; transform: translateY(6px); } }
@keyframes ob-pick { from { fill: var(--ob-gold-soft); stroke: var(--ob-gold); } }
@keyframes ob-pick-t { from { fill: var(--ob-ink); } }
@keyframes ob-press {
  0% { transform: translate(40px, 60px); opacity: 0; }
  60% { transform: translate(0, 0); opacity: 1; }
  80% { transform: translate(0, 0); opacity: 1; }
  100% { transform: translate(30px, 50px); opacity: 0; }
}
@keyframes ob-fade { from { opacity: 1; } }
@keyframes ob-scroll { from { transform: translateY(0); } }
@keyframes ob-return { from { transform: translateY(50px); opacity: 0; } }
@keyframes ob-grow { 0%, 15% { transform: scaleY(0.72); } 70%, 100% { transform: scaleY(1); } }
@keyframes ob-pinch-a { 0%, 15% { transform: translateY(22px); } 70%, 100% { transform: translateY(0); } }
@keyframes ob-pinch-b { 0%, 15% { transform: translateY(-22px); } 70%, 100% { transform: translateY(0); } }
`;
