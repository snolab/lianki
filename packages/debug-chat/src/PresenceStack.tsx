/**
 * Who is here (docs/dev-debug-widget.md, "Who is here"): the participants of
 * this chat thread (presence.ts: tokens reading now or lately, recent
 * speakers), as overlapping avatars right of the connection chip, most
 * recently active first, `shown` of them (live config chat.presenceShown)
 * then "+N".
 *
 * A mouse hovering it, or one tap on a touch screen, shows a one-line
 * summary of names; a mouse click, a double tap, or Enter opens the panel:
 * one row per participant (avatar, name, MCP badge, activity) and, for the
 * viewer's own tokens, Rename, Picture (generated / the agent's own / a
 * pasted SVG, the same sanitizer as the hub's) and Remove (revokes the
 * token, after one confirm step). Invite links to the token form,
 * prefilled for a chat-only token, and shows the connect snippet.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar } from "./Avatar";
import { McpBadge, agentAvatar } from "./LaneMark";
import {
  INVITE_HREF,
  type Present,
  mcpSnippet,
  presenceSummary,
  stackOf,
} from "./presence";
import { sanitizeAvatarSvg } from "./svg-avatar";
import type { UiStrings } from "./ui-strings";

export type PresenceWords = Pick<
  UiStrings,
  | "people"
  | "peopleNow"
  | "peopleActive"
  | "peopleSince"
  | "peopleRemove"
  | "peopleRemoveAsk"
  | "peopleCancel"
  | "peopleFailed"
  | "peopleName"
  | "peopleSave"
  | "peopleAuto"
  | "peopleOwn"
  | "peoplePaste"
  | "peopleByYou"
  | "peopleInvite"
  | "peopleInviteHow"
  | "peopleCopy"
  | "peopleClose"
>;

/** A participant's change: a name (null: its own back), a picture ("auto", an SVG, null: its own back). */
export type ParticipantChange = { name?: string | null; avatar?: string | null };

const SEAL = "var(--lk-primary, oklch(0.53 0.207 22.3))";
const PAPER = "var(--lk-on-primary, oklch(0.985 0.01 85))";
const keep = (e: { preventDefault(): void }) => e.preventDefault();
const AV = 18;
const DOUBLE_TAP_MS = 350;
/** The paste box's sample: code, the same in every language. */
const SVG_SAMPLE = '<svg viewBox="0 0 24 24">…</svg>';

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** The picture an entry is drawn with (its own, its lane's, or the generated mark). */
const pictureOf = (p: Present, mainName: string) =>
  agentAvatar({ name: p.name || mainName, lane: p.lane, avatar: p.avatar });

export function PresenceStack({
  list,
  shown,
  t,
  mainName,
  glass = false,
  onChange,
  onRemove,
}: {
  list: readonly Present[];
  shown: number;
  t: PresenceWords;
  /** Main's name (the host's agent name), for its entry. */
  mainName: string;
  glass?: boolean;
  /** The viewer renames a token of theirs or sets its picture (over the hub socket). */
  onChange?: (tok: string, change: ParticipantChange) => void;
  /** Revoke a token of the viewer's (/api/token DELETE): true when it went. */
  onRemove?: (id: string) => Promise<boolean>;
}) {
  const [tip, setTip] = useState(false);
  const [open, setOpen] = useState(false);
  const lastTap = useRef(0);
  /** How the last press came: "mouse", "touch", "pen". */
  const pointer = useRef<string>("mouse");
  const box = useRef<HTMLDivElement>(null);
  const named = list.map((p) => ({ ...p, name: p.name || mainName }));
  const stack = stackOf(named, shown);
  const summary = presenceSummary(named, shown);

  // Outside a tap, or Escape: the panel closes.
  useEffect(() => {
    if (!open && !tip) return;
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false);
        setTip(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setTip(false);
      }
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, tip]);

  if (!list.length && !onRemove) return null;
  return (
    <div ref={box} className={`pointer-events-auto relative flex shrink-0 ${glass ? "" : "mb-1"}`}>
      <button
        type="button"
        data-testid="debug-chat-presence"
        data-count={list.length}
        aria-label={`${t.people}: ${summary}`}
        aria-expanded={open}
        onPointerDown={(e) => {
          pointer.current = e.pointerType;
          keep(e);
        }}
        onPointerEnter={(e) => e.pointerType === "mouse" && setTip(true)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setTip(false)}
        onClick={(e) => {
          // A mouse click or a key: the panel. A touch: one tap the summary, two the panel.
          if (e.detail === 0 || pointer.current === "mouse") {
            setTip(false);
            setOpen((o) => !o);
            return;
          }
          const now = Date.now();
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            lastTap.current = 0;
            setTip(false);
            setOpen(true);
          } else {
            lastTap.current = now;
            setTip((x) => !x);
          }
        }}
        className="inline-flex min-h-5 items-center rounded px-0.5 py-0.5 leading-none"
      >
        {stack.shown.map((p, i) => (
          <span
            key={p.key}
            data-testid="debug-chat-presence-avatar"
            data-key={p.key}
            className={`relative inline-flex rounded-full ring-1 ring-[oklch(0.98_0.005_85)] dark:ring-[oklch(0.22_0.01_260)] ${i ? "-ms-1.5" : ""}`}
            style={{ zIndex: stack.shown.length - i }}
          >
            <Avatar src={pictureOf(p, mainName)} name={p.name} size={AV} hidden />
          </span>
        ))}
        {stack.more > 0 && (
          <span
            data-testid="debug-chat-presence-more"
            className="-ms-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[oklch(0.9_0.01_260)] px-1 fs-9 font-semibold text-[oklch(0.35_0.02_260)] ring-1 ring-[oklch(0.98_0.005_85)] dark:bg-[oklch(0.35_0.02_260)] dark:text-[oklch(0.92_0.01_260)] dark:ring-[oklch(0.22_0.01_260)]"
          >
            +{stack.more}
          </span>
        )}
        {!list.length && (
          <span aria-hidden className="fs-12 text-gray-500">
            +
          </span>
        )}
      </button>
      {tip && !open && list.length > 0 && (
        <div
          role="tooltip"
          data-testid="debug-chat-presence-tip"
          className="absolute bottom-full start-0 z-40 mb-1 max-w-[min(20rem,calc(100vw-2rem))] truncate rounded-md bg-gray-900/90 px-2 py-1 fs-11 text-white shadow dark:bg-gray-100/90 dark:text-gray-900"
        >
          {summary}
        </div>
      )}
      {open && (
        <Panel
          list={named}
          t={t}
          mainName={mainName}
          onChange={onChange}
          onRemove={onRemove}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function Panel({
  list,
  t,
  mainName,
  onChange,
  onRemove,
  onClose,
}: {
  list: readonly Present[];
  t: PresenceWords;
  mainName: string;
  onChange?: (tok: string, change: ParticipantChange) => void;
  onRemove?: (id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [inviting, setInviting] = useState(false);
  return (
    <div
      role="dialog"
      aria-label={t.people}
      data-testid="debug-chat-presence-panel"
      className="absolute bottom-full start-0 z-40 mb-1 flex max-h-[60vh] w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto rounded-xl border border-current/20 bg-gray-50/95 p-2.5 fs-12 leading-snug text-gray-900 shadow-lg backdrop-blur-md dark:bg-gray-900/95 dark:text-gray-100"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 font-semibold">{t.people}</span>
        <button
          type="button"
          onPointerDown={keep}
          onClick={onClose}
          className="tap-40 rounded px-1.5 leading-6 opacity-80"
        >
          {t.peopleClose}
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {list.map((p) => (
          <Row key={p.key} p={p} t={t} mainName={mainName} onChange={onChange} onRemove={onRemove} />
        ))}
      </ul>
      {onRemove && (
        <div className="border-t border-current/10 pt-2">
          <button
            type="button"
            data-testid="debug-chat-presence-invite"
            onPointerDown={keep}
            onClick={() => setInviting((x) => !x)}
            aria-expanded={inviting}
            className="tap-40 rounded-full px-2.5 leading-6 font-medium"
            style={{ background: SEAL, color: PAPER }}
          >
            {t.peopleInvite}
          </button>
          {inviting && <Invite t={t} />}
        </div>
      )}
    </div>
  );
}

function Invite({ t }: { t: PresenceWords }) {
  const [copied, setCopied] = useState(false);
  const snippet = mcpSnippet(typeof location === "undefined" ? undefined : location.origin);
  return (
    <div data-testid="debug-chat-presence-invite-box" className="mt-2 flex flex-col gap-1.5">
      <p>
        <a href={INVITE_HREF} className="underline" data-testid="debug-chat-presence-invite-link">
          {t.peopleInviteHow}
        </a>
      </p>
      <pre className="overflow-x-auto rounded bg-black/5 p-1.5 fs-11 dark:bg-white/10">{snippet}</pre>
      <button
        type="button"
        onPointerDown={keep}
        onClick={() =>
          void navigator.clipboard?.writeText(snippet).then(
            () => setCopied(true),
            () => {},
          )
        }
        className="tap-40 self-start rounded px-1.5 leading-6 underline"
      >
        {copied ? "✓ " : ""}
        {t.peopleCopy}
      </button>
    </div>
  );
}

function Row({
  p,
  t,
  mainName,
  onChange,
  onRemove,
}: {
  p: Present;
  t: PresenceWords;
  mainName: string;
  onChange?: (tok: string, change: ParticipantChange) => void;
  onRemove?: (id: string) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [svgBad, setSvgBad] = useState(false);
  const mine = !!p.id && !!p.tok;
  const activity: ReactNode[] = [];
  if (p.live) activity.push(t.peopleNow);
  else activity.push(t.peopleActive.replaceAll("{time}", clock(p.active)));
  if (p.since) activity.push(t.peopleSince.replaceAll("{time}", clock(p.since)));
  const btn = "tap-40 rounded px-1.5 leading-6 underline";
  /** The picture in effect: one of three, all shown; the one in effect in seal red. */
  const pic = !p.avatar ? "auto" : p.avatarBy === "agent" ? "own" : "pasted";
  const choice = (on: boolean) =>
    `tap-40 rounded-full border px-2 leading-6 ${on ? "border-transparent font-semibold text-[var(--lk-on-primary,oklch(0.985_0.01_85))] bg-[var(--lk-primary,oklch(0.53_0.207_22.3))]" : "border-current/30 text-gray-500"}`;
  return (
    <li data-testid="debug-chat-presence-row" data-key={p.key} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Avatar src={pictureOf(p, mainName)} name={p.name} size={24} hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {p.name || mainName}
            {p.mcp && <McpBadge />}
            {p.nameBy === "owner" && (
              <span className="ms-1 fs-10 opacity-70">({t.peopleByYou})</span>
            )}
          </span>
          <span className="block opacity-80">{activity.join(" · ")}</span>
        </span>
        {mine && onRemove && !asking && (
          <button
            type="button"
            data-testid="debug-chat-presence-remove"
            onPointerDown={keep}
            onClick={() => setAsking(true)}
            className="tap-40 shrink-0 rounded-full px-2.5 leading-6 font-medium"
            style={{ background: SEAL, color: PAPER }}
          >
            {t.peopleRemove}
          </button>
        )}
      </div>
      {asking && (
        <div data-testid="debug-chat-presence-confirm" className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">{t.peopleRemoveAsk.replaceAll("{name}", p.name)}</span>
          <button
            type="button"
            data-testid="debug-chat-presence-remove-yes"
            disabled={busy}
            onPointerDown={keep}
            onClick={async () => {
              setBusy(true);
              setFailed(false);
              const ok = await onRemove!(p.id!).catch(() => false);
              setBusy(false);
              if (ok) setAsking(false);
              else setFailed(true);
            }}
            className="tap-40 rounded-full px-2.5 leading-6 font-medium"
            style={{ background: SEAL, color: PAPER }}
          >
            {t.peopleRemove}
          </button>
          <button type="button" onPointerDown={keep} onClick={() => setAsking(false)} className={btn}>
            {t.peopleCancel}
          </button>
        </div>
      )}
      {failed && (
        <p role="alert" className="opacity-90">
          ⚠ {t.peopleFailed}
        </p>
      )}
      {mine && onChange && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 ps-8">
          {name === null ? (
            <button type="button" onPointerDown={keep} onClick={() => setName(p.name)} className={btn}>
              {t.peopleName}
            </button>
          ) : (
            <form
              className="flex w-full items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const n = name.trim();
                onChange(p.tok!, { name: n && n !== p.selfName ? n : null });
                setName(null);
              }}
            >
              <input
                data-testid="debug-chat-presence-name"
                value={name}
                maxLength={40}
                aria-label={t.peopleName}
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 flex-1 rounded border border-current/20 bg-transparent px-1.5 leading-6"
              />
              <button type="submit" className={btn}>
                {t.peopleSave}
              </button>
            </form>
          )}
          <button
            type="button"
            data-testid="debug-chat-presence-auto"
            aria-pressed={pic === "auto"}
            onPointerDown={keep}
            onClick={() => onChange(p.tok!, { avatar: "auto" })}
            className={choice(pic === "auto")}
          >
            {t.peopleAuto}
          </button>
          <button
            type="button"
            aria-pressed={pic === "own"}
            onPointerDown={keep}
            onClick={() => onChange(p.tok!, { avatar: null })}
            className={choice(pic === "own")}
          >
            {t.peopleOwn}
          </button>
          <button
            type="button"
            aria-pressed={pic === "pasted"}
            onPointerDown={keep}
            onClick={() => setSvg((x) => (x === null ? "" : null))}
            className={choice(pic === "pasted")}
          >
            {t.peoplePaste}
          </button>
          {svg !== null && (
            <form
              className="flex w-full flex-col gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const s = sanitizeAvatarSvg(svg);
                if (!s.ok) return setSvgBad(true);
                onChange(p.tok!, { avatar: s.svg });
                setSvg(null);
                setSvgBad(false);
              }}
            >
              <textarea
                data-testid="debug-chat-presence-svg"
                value={svg}
                rows={3}
                aria-label={t.peoplePaste}
                aria-invalid={svgBad || undefined}
                placeholder={SVG_SAMPLE}
                onChange={(e) => {
                  setSvg(e.target.value);
                  setSvgBad(false);
                }}
                className="w-full rounded border border-current/20 bg-transparent p-1 fs-11 font-mono"
              />
              {svgBad && <span role="alert">⚠ {t.peopleFailed}</span>}
              <button type="submit" className={`${btn} self-start`}>
                {t.peopleSave}
              </button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}
