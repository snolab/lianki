/**
 * Who is here (docs/dev-debug-widget.md, "Who is here"): the participants of
 * this chat thread (presence.ts: tokens reading now or lately, recent
 * speakers), right of the connection chip. The stack draws avatars only for
 * those who can answer now (live lanes, tokens, people), most recently active
 * first, `shown` of them (live config chat.presenceShown) then "+K"; the
 * read-only lanes (mode "reader", lane-registry.ts) are one chip "+N
 * read-only" at the end (owner, 2026-11-16 "为什么我们有好几个方框头像…简化一点").
 *
 * A mouse hovering it, or one tap on a touch screen, shows a one-line
 * summary; a mouse click, a double tap, or Enter opens the panel: one row per
 * live participant (avatar, name · role, and a strip of state icons:
 * listening ear / bell / closed eye, permissions post / read / code, each
 * tapped for its meaning), the read-only lanes collapsed into one row that
 * opens to plain names, and a quiet Invite row at the bottom. Each row's "…"
 * holds the rest: its activity and, for the viewer's own tokens, Rename,
 * Picture (generated / the agent's own / a pasted SVG, the same sanitizer as
 * the hub's) and Remove (revokes the token, after one confirm step).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar } from "./Avatar";
import { McpBadge, agentAvatar } from "./LaneMark";
import {
  INVITE_HREF,
  type Present,
  mcpSnippet,
  knownState,
  type ListenState,
  liveFirst,
  presenceSummary,
  stackOf,
} from "./presence";
import { laneRole } from "./roster";
import { laneTable } from "./voices";
import { sanitizeAvatarSvg } from "./svg-avatar";
import { laneModeWord } from "./lane-events";
import { Icon, type IconName } from "./icons";
import { chatLocale } from "./chat-ui-locales";
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
  | "peopleReadOnly"
  | "peopleReadersChip"
  | "peopleReadersRow"
  | "peopleActions"
  | "peoplePicture"
  | "peopleListening"
  | "peopleHearsAll"
  | "peopleHearsYours"
  | "peopleWokenByName"
  | "peopleNotListening"
  | "peoplePerms"
  | "peopleCanPost"
  | "peopleCannotPost"
  | "peopleCanRead"
  | "peopleCannotRead"
  | "peopleCanEval"
  | "peopleCannotEval"
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

/**
 * The small dot on a live listener's avatar (lane-registry.ts): filled seal red when it hears
 * every line (tier ①, scope "all"), a red ring when it hears the owner's lines only (tier ②).
 * Readers and muted lanes get none. Its title is the mode word (lane-events.ts).
 */
export function LiveMark({ p }: { p: Pick<Present, "mode" | "muted" | "scope"> }) {
  if (p.mode !== "listener" || p.muted) return null;
  const all = p.scope === "all";
  return (
    <span
      data-testid="debug-chat-presence-live"
      data-scope={all ? "all" : "owner"}
      title={laneModeWord(p, chatLocale()) ?? undefined}
      className="absolute -bottom-px -end-px h-1.5 w-1.5 rounded-full ring-1 ring-[oklch(0.98_0.005_85)] dark:ring-[oklch(0.22_0.01_260)]"
      style={
        all
          ? { background: SEAL }
          : { background: "oklch(0.98 0.005 85)", boxShadow: `inset 0 0 0 1.5px ${SEAL}` }
      }
    />
  );
}

/** An entry's role (its lane's, roster.ts), or undefined. */
const roleOf = (p: Present) =>
  laneRole({ id: p.lane ?? p.selfName ?? p.name, name: p.name }, laneTable());

/** The picture an entry is drawn with (its own, its lane's, or the generated mark). */
const pictureOf = (p: Present, mainName: string) =>
  agentAvatar({ name: p.name || mainName, lane: p.lane, avatar: p.avatar });

/** The small grey chip style shared by "+K" and "+N read-only" in the stack. */
const CHIP =
  "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[oklch(0.9_0.01_260)] px-1 fs-9 font-semibold text-[oklch(0.35_0.02_260)] ring-1 ring-[oklch(0.98_0.005_85)] dark:bg-[oklch(0.35_0.02_260)] dark:text-[oklch(0.92_0.01_260)] dark:ring-[oklch(0.22_0.01_260)]";

/** A full-width, 44px-tall item in the panel (a menu entry, the readers row, Invite). */
const ITEM =
  "flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-start hover:bg-[oklch(0.5_0.02_250/0.1)] focus-visible:outline-2 focus-visible:outline-offset-[-2px]";

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
  const groups = liveFirst(list.map((p) => ({ ...p, name: p.name || mainName })));
  // Avatars only for those who can answer now; the read-only lanes are one count chip.
  const stack = stackOf(groups.live, shown);
  const readersChip = groups.readers.length
    ? t.peopleReadersChip.replaceAll("{n}", String(groups.readers.length))
    : "";
  const summary = [presenceSummary(groups.live, shown), readersChip].filter(Boolean).join(" · ");

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
        className="tap-40 inline-flex min-h-5 items-center rounded px-0.5 py-0.5 leading-none"
      >
        {stack.shown.map((p, i) => (
          <span
            key={p.key}
            data-testid="debug-chat-presence-avatar"
            data-key={p.key}
            data-mode={p.mode}
            className={`relative inline-flex rounded-full ring-1 ring-[oklch(0.98_0.005_85)] dark:ring-[oklch(0.22_0.01_260)] ${i ? "-ms-1.5" : ""}`}
            style={{ zIndex: stack.shown.length - i }}
          >
            <Avatar src={pictureOf(p, mainName)} name={p.name} size={AV} hidden />
            <LiveMark p={p} />
          </span>
        ))}
        {stack.more > 0 && (
          <span data-testid="debug-chat-presence-more" className={`-ms-1.5 ${CHIP}`}>
            +{stack.more}
          </span>
        )}
        {readersChip && (
          <span
            data-testid="debug-chat-presence-readers-chip"
            className={`${stack.shown.length ? "ms-1" : ""} ${CHIP} font-medium opacity-80`}
          >
            {readersChip}
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
          live={groups.live}
          readers={groups.readers}
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
  live,
  readers,
  t,
  mainName,
  onChange,
  onRemove,
  onClose,
}: {
  live: readonly Present[];
  readers: readonly Present[];
  t: PresenceWords;
  mainName: string;
  onChange?: (tok: string, change: ParticipantChange) => void;
  onRemove?: (id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const row = (p: Present, plain = false) => (
    <Row
      key={p.key}
      p={p}
      t={t}
      mainName={mainName}
      plain={plain}
      onChange={onChange}
      onRemove={onRemove}
    />
  );
  const [inviting, setInviting] = useState(false);
  const [showReaders, setShowReaders] = useState(false);
  return (
    <div
      role="dialog"
      aria-label={t.people}
      data-testid="debug-chat-presence-panel"
      // A drag inside the panel scrolls the panel only: a short list is not scrollable, and
      // without this the chat behind takes the drag (owner, 2026-11-15 04:14 JST "滚动穿透").
      onTouchMove={(e) => {
        const el = e.currentTarget;
        if (el.scrollHeight <= el.clientHeight) e.preventDefault();
      }}
      className="absolute bottom-full start-0 z-40 mb-1 flex max-h-[60vh] w-[min(22rem,calc(100vw-2rem))] flex-col gap-1 overflow-y-auto overscroll-contain touch-pan-y rounded-xl border border-current/20 bg-gray-50/95 p-2 fs-12 leading-snug text-gray-900 shadow-lg backdrop-blur-md dark:bg-gray-900/95 dark:text-gray-100"
    >
      <div className="flex items-center gap-2 ps-1">
        <span className="flex-1 font-semibold">{t.people}</span>
        <button
          type="button"
          onPointerDown={keep}
          onClick={onClose}
          className="min-h-11 rounded px-2 opacity-80"
        >
          {t.peopleClose}
        </button>
      </div>
      {live.length > 0 && <ul className="flex flex-col">{live.map((p) => row(p))}</ul>}
      {readers.length > 0 && (
        <section
          data-testid="debug-chat-presence-readers"
          className="border-t border-current/10 pt-1"
        >
          <button
            type="button"
            data-testid="debug-chat-presence-readers-toggle"
            aria-expanded={showReaders}
            onPointerDown={keep}
            onClick={() => setShowReaders((x) => !x)}
            className={`${ITEM} opacity-80`}
          >
            <span className="min-w-0 flex-1 truncate">
              {t.peopleReadersRow.replaceAll("{n}", String(readers.length))}
            </span>
            <span aria-hidden className={showReaders ? "rotate-180" : ""}>
              ▾
            </span>
          </button>
          {showReaders && (
            <ul aria-label={t.peopleReadOnly} className="flex flex-col ps-2">
              {readers.map((p) => row(p, true))}
            </ul>
          )}
        </section>
      )}
      {onRemove && (
        <div className="border-t border-current/10 pt-1">
          <button
            type="button"
            data-testid="debug-chat-presence-invite"
            onPointerDown={keep}
            onClick={() => setInviting((x) => !x)}
            aria-expanded={inviting}
            className={`${ITEM} opacity-80`}
          >
            <span aria-hidden>+</span>
            <span className="min-w-0 flex-1 truncate">{t.peopleInvite}</span>
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
    <div data-testid="debug-chat-presence-invite-box" className="flex flex-col gap-1.5 px-2 pb-1">
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
        className="min-h-11 self-start rounded px-2 underline"
      >
        {copied ? "✓ " : ""}
        {t.peopleCopy}
      </button>
    </div>
  );
}

/**
 * One participant. Shown: avatar, name and one line (its role, else what it is doing); a read-only
 * lane ("plain") just its name. The "…" opens the rest: its activity and, for the viewer's own
 * tokens, Rename, Picture and Remove.
 */
function Row({
  p,
  t,
  mainName,
  plain,
  onChange,
  onRemove,
}: {
  p: Present;
  t: PresenceWords;
  mainName: string;
  plain: boolean;
  onChange?: (tok: string, change: ParticipantChange) => void;
  onRemove?: (id: string) => Promise<boolean>;
}) {
  const [menu, setMenu] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [svgBad, setSvgBad] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const mine = !!p.id && !!p.tok;
  // Its listening mode (lane-registry.ts) is drawn as icons; the words are for the "…" details.
  const activity: ReactNode[] = [];
  if (p.live) activity.push(t.peopleNow);
  else activity.push(t.peopleActive.replaceAll("{time}", clock(p.active)));
  if (p.since) activity.push(t.peopleSince.replaceAll("{time}", clock(p.since)));
  const doing = activity.join(" · ");
  const role = roleOf(p);
  const shownName = p.name || mainName;
  // A read-only lane that is not the viewer's: its name and nothing more.
  const hasMenu = !plain || (mine && (!!onChange || !!onRemove));
  /** The picture in effect: one of three, all shown; the one in effect in seal red. */
  const pic = !p.avatar ? "auto" : p.avatarBy === "agent" ? "own" : "pasted";
  const seg = (on: boolean) =>
    `min-h-11 flex-1 px-1 fs-11 leading-tight ${on ? "font-semibold text-[var(--lk-on-primary,oklch(0.985_0.01_85))] bg-[var(--lk-primary,oklch(0.53_0.207_22.3))]" : "text-gray-500"}`;
  const btn = "min-h-11 rounded px-2 underline";
  const state = knownState(p);
  /** One state icon: a tap (or hover) gives its one-line meaning. */
  const icon = (
    kind: string,
    name: IconName,
    meaning: string,
    on: boolean,
    look: string,
    weight: "regular" | "fill" = "regular",
  ) => (
    <button
      key={kind}
      type="button"
      data-testid="debug-chat-presence-icon"
      data-kind={kind}
      data-on={on}
      aria-label={meaning}
      title={meaning}
      onPointerDown={keep}
      onClick={() => setInfo((x) => (x === meaning ? null : meaning))}
      className="inline-flex h-11 w-8 items-center justify-center fs-14"
    >
      {/* The look sits inside: the button stays 44px tall to tap, the segment 28px to see. */}
      <span className={`inline-flex h-7 w-full items-center justify-center ${look}`}>
        <Icon name={name} weight={weight} />
      </span>
    </button>
  );
  const ear = state.listen === "yours" ? t.peopleHearsYours : t.peopleHearsAll;
  const listenOn = (k: ListenState[]) => !!state.listen && k.includes(state.listen);
  /** A segment of the listening group: its edge rounded, all three bordered as one pill. */
  const segLook = (on: boolean, edge: "start" | "mid" | "end") =>
    `border-y border-current/20 ${edge === "start" ? "rounded-s-full border-s" : edge === "end" ? "rounded-e-full border-e" : ""} ` +
    (on
      ? "text-[var(--lk-on-primary,oklch(0.985_0.01_85))] bg-[var(--lk-primary,oklch(0.53_0.207_22.3))]"
      : "text-gray-400 dark:text-gray-500");
  const listening: [string, IconName, string, ListenState[], "start" | "mid" | "end"][] = [
    ["listen-ear", "ear", ear, ["all", "yours"], "start"],
    ["listen-bell", "bell", t.peopleWokenByName, ["named"], "mid"],
    ["listen-off", "eyeClosed", t.peopleNotListening, ["off"], "end"],
  ];
  const listenIcons = listening.map(([kind, name, meaning, states, edge]) =>
    icon(kind, name, meaning, listenOn(states), segLook(listenOn(states), edge)),
  );
  const perm = (kind: string, name: IconName, has: boolean | undefined, yes: string, no: string) =>
    has === undefined
      ? null
      : icon(
          kind,
          name,
          has ? yes : no,
          has,
          has ? "" : "text-gray-400 dark:text-gray-500",
          has ? "fill" : "regular",
        );
  const perms = [
    perm("post", "chatBubble", state.post, t.peopleCanPost, t.peopleCannotPost),
    perm("read", "eye", state.read, t.peopleCanRead, t.peopleCannotRead),
    perm("eval", "code", state.eval, t.peopleCanEval, t.peopleCannotEval),
  ].filter(Boolean);
  return (
    <li
      data-testid={plain ? "debug-chat-presence-reader" : "debug-chat-presence-row"}
      data-key={p.key}
      className="flex flex-col"
    >
      <div className="flex min-h-11 items-center gap-2 ps-1">
        {!plain && (
          <span className="inline-flex shrink-0">
            <Avatar src={pictureOf(p, mainName)} name={p.name} size={24} hidden />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <span className="font-medium">{shownName}</span>
            {!plain && p.mcp && <McpBadge />}
            {!plain && p.nameBy === "owner" && (
              <span className="ms-1 fs-10 opacity-70">({t.peopleByYou})</span>
            )}
            {!plain && role && (
              <span data-testid="debug-chat-presence-role" className="opacity-70">
                {" · "}
                {role}
              </span>
            )}
          </span>
          {!plain && (state.listen || perms.length > 0) && (
            <span className="-my-2 flex items-center gap-2">
              {state.listen && (
                <span
                  role="group"
                  aria-label={t.peopleListening}
                  className="inline-flex items-center"
                >
                  {listenIcons}
                </span>
              )}
              {perms.length > 0 && (
                <span role="group" aria-label={t.peoplePerms} className="inline-flex items-center">
                  {perms}
                </span>
              )}
            </span>
          )}
        </span>
        {hasMenu && (
          <button
            type="button"
            data-testid="debug-chat-presence-menu"
            aria-label={t.peopleActions.replaceAll("{name}", shownName)}
            aria-expanded={menu}
            onPointerDown={keep}
            onClick={() => setMenu((x) => !x)}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg fs-16 leading-none opacity-70 hover:bg-[oklch(0.5_0.02_250/0.1)]"
          >
            …
          </button>
        )}
      </div>
      {info && (
        <p
          role="status"
          data-testid="debug-chat-presence-icon-tip"
          className="ms-8 mb-1 rounded-md bg-gray-900/90 px-2 py-1 fs-11 text-white dark:bg-gray-100/90 dark:text-gray-900"
        >
          {info}
        </p>
      )}
      {menu && (
        <div
          data-testid="debug-chat-presence-menu-box"
          className="mb-1 ms-8 flex flex-col rounded-lg bg-black/5 p-1 dark:bg-white/10"
        >
          <p data-testid="debug-chat-presence-activity" className="px-2 py-1 opacity-80">
            {doing}
          </p>
          {mine && onChange && (
            <>
              {name === null ? (
                <button
                  type="button"
                  onPointerDown={keep}
                  onClick={() => setName(p.name)}
                  className={ITEM}
                >
                  {t.peopleName}
                </button>
              ) : (
                <form
                  className="flex w-full items-center gap-1 px-1"
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
                    className="min-h-11 min-w-0 flex-1 rounded border border-current/20 bg-transparent px-1.5"
                  />
                  <button type="submit" className={btn}>
                    {t.peopleSave}
                  </button>
                </form>
              )}
              <button
                type="button"
                data-testid="debug-chat-presence-picture"
                aria-expanded={picking}
                onPointerDown={keep}
                onClick={() => setPicking((x) => !x)}
                className={ITEM}
              >
                {t.peoplePicture}
              </button>
              {picking && (
                <div className="flex flex-col gap-1 px-1 pb-1">
                  <div
                    role="group"
                    aria-label={t.peoplePicture}
                    className="flex w-full overflow-hidden rounded-full border border-current/30"
                  >
                    <button
                      type="button"
                      data-testid="debug-chat-presence-auto"
                      aria-pressed={pic === "auto"}
                      onPointerDown={keep}
                      onClick={() => onChange(p.tok!, { avatar: "auto" })}
                      className={seg(pic === "auto")}
                    >
                      {t.peopleAuto}
                    </button>
                    <button
                      type="button"
                      aria-pressed={pic === "own"}
                      onPointerDown={keep}
                      onClick={() => onChange(p.tok!, { avatar: null })}
                      className={seg(pic === "own")}
                    >
                      {t.peopleOwn}
                    </button>
                    <button
                      type="button"
                      aria-pressed={pic === "pasted"}
                      onPointerDown={keep}
                      onClick={() => setSvg((x) => (x === null ? "" : null))}
                      className={seg(pic === "pasted")}
                    >
                      {t.peoplePaste}
                    </button>
                  </div>
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
            </>
          )}
          {mine && onRemove && !asking && (
            <button
              type="button"
              data-testid="debug-chat-presence-remove"
              onPointerDown={keep}
              onClick={() => setAsking(true)}
              className={ITEM}
            >
              {t.peopleRemove}
            </button>
          )}
          {asking && (
            <div
              data-testid="debug-chat-presence-confirm"
              className="flex flex-wrap items-center gap-2 px-2 py-1"
            >
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
                className="min-h-11 rounded-full px-3 font-medium"
                style={{ background: SEAL, color: PAPER }}
              >
                {t.peopleRemove}
              </button>
              <button
                type="button"
                onPointerDown={keep}
                onClick={() => setAsking(false)}
                className={btn}
              >
                {t.peopleCancel}
              </button>
            </div>
          )}
          {failed && (
            <p role="alert" className="px-2 py-1 opacity-90">
              ⚠ {t.peopleFailed}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
