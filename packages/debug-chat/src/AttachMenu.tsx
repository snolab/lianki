/**
 * The chat input's + button, its menu, the chip of what is attached, and the
 * quote shown above a sent line (attach.ts; docs/dev-debug-widget.md, "The +
 * menu"). The menu's View group opens the state tree (the bar has no tree
 * button since 2026-11-03). Every button keeps the input's focus (pointerdown preventDefault),
 * so a phone's keyboard stays up and the remembered selection stays put.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ADD_ITEMS_EVENT,
  ATTACH_KINDS,
  CHAT_FENCE,
  type AddItem,
  type PageSelection,
  addItems,
  announceChatAttach,
  createSelectionMemory,
  oneLine,
} from "./attach";
import { BAR_CONTROL } from "./bar-geometry";
import { HistoryIcon, Icon, type IconName, TreeIcon } from "./icons";
import type { ChatContext, ChatStrings } from "./wire";

type Memory = ReturnType<typeof createSelectionMemory>;
const MEMORY = "__lkPageSelection";

/** The chat's own elements: its box (and anything portalled with the mark) and an embed's shadow host. */
const CHAT_SELECTOR = CHAT_FENCE;
function inChat(node: unknown): boolean {
  const n = node as (Node & { closest?: (s: string) => Element | null }) | null;
  if (!n || typeof n !== "object") return false;
  const el = n.nodeType === 1 ? (n as unknown as Element) : n.parentElement;
  return !!el?.closest?.(CHAT_SELECTOR);
}

/** One memory per page (shared by a hot swap of the widget), started once. */
function pageSelection(embedded: boolean): Memory | null {
  if (typeof document === "undefined") return null;
  const g = globalThis as unknown as Record<string, Memory | undefined>;
  if (g[MEMORY]) return g[MEMORY];
  const m = createSelectionMemory({
    doc: document as never,
    inChat,
    where: () => ({
      path: location.pathname,
      title: document.title,
      // On another site (the userscript), the agent needs to know which.
      ...(embedded ? { host: location.host } : {}),
    }),
  });
  m.start();
  g[MEMORY] = m;
  return m;
}

const NONE = () => null;
/** The remembered page selection (null: nothing selected outside the chat). */
export function usePageSelection(embedded: boolean): { sel: PageSelection | null; clear(): void } {
  const m = pageSelection(embedded);
  const sel = useSyncExternalStore(
    m ? m.subscribe : () => () => {},
    m ? m.get : NONE,
    NONE,
  );
  return { sel, clear: () => m?.clear() };
}

/** The app's add items (the bottom island's Create actions), live. */
export function useAddItems(): readonly AddItem[] {
  return useSyncExternalStore(
    (f) => {
      globalThis.addEventListener?.(ADD_ITEMS_EVENT, f);
      return () => globalThis.removeEventListener?.(ADD_ITEMS_EVENT, f);
    },
    addItems,
    addItems,
  );
}

const keep = (e: { preventDefault(): void }) => e.preventDefault();
const ICON_NAMES = new Set<string>(["plus", "link", "uploadSimple", "textAa", "sparkle", "play"]);
const iconOf = (name: string | undefined): IconName =>
  name && ICON_NAMES.has(name) ? (name as IconName) : "plus";

/**
 * The + at the start of the input. With `announce` (its Add and Attach groups
 * shown) it announces itself, and the bottom island drops its ＋. `sessions`:
 * the eval/preview sessions (the tree row's count) — a dot on the + while
 * there are any, pulsing when code just ran (`ran`), as on the old tree button.
 */
export function AttachButton({
  t,
  open,
  announce = true,
  sessions = 0,
  ran = false,
  onToggle,
}: {
  t: ChatStrings;
  open: boolean;
  announce?: boolean;
  sessions?: number;
  ran?: boolean;
  onToggle: () => void;
}) {
  useEffect(() => (announce ? announceChatAttach() : undefined), [announce]);
  // Without its Add and Attach groups, the menu holds only the state tree.
  const label = announce ? t.attachOpen : t.attachTree;
  return (
    <button
      type="button"
      data-chat-attach
      data-testid="debug-chat-attach"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onPointerDown={keep}
      onClick={onToggle}
      // One line box high, as the bar's other controls (bar-geometry.ts).
      style={BAR_CONTROL}
      data-lk-tap
      className="tap-40 relative flex shrink-0 items-center justify-center self-end rounded-full text-base text-gray-500 dark:text-gray-400"
    >
      <Icon name="plus" />
      {sessions > 0 && (
        <span
          aria-hidden
          data-testid="debug-chat-evals"
          className={`absolute end-1.5 top-1 size-1.5 rounded-full ${ran ? "animate-pulse" : ""}`}
          style={{ background: "oklch(0.55 0.15 30)" }}
        />
      )}
    </button>
  );
}

/**
 * The + menu: "Add" (the app's items), "Attach to message" (ATTACH_KINDS),
 * then "View" (the state tree). Without `attach` (the cross-site iframe, or
 * the chat unavailable) only View is shown.
 */
export function AttachMenu({
  t,
  attach = true,
  sel,
  items,
  tree,
  sessions = 0,
  sessionsLabel,
  onTree,
  onAttachSelection,
  upload = false,
  onPickFiles,
  onInbox,
  onHistory,
  onClose,
}: {
  t: ChatStrings;
  attach?: boolean;
  sel: PageSelection | null;
  items: readonly AddItem[];
  /** The state tree is open (its row is checked; a pick closes it). */
  tree: boolean;
  /** The eval/preview sessions: their count on the tree row. */
  sessions?: number;
  /** "N connections", for screen readers (English, as the menu's status). */
  sessionsLabel?: string;
  onTree: () => void;
  onAttachSelection: () => void;
  /** The host takes files (ChatFiles): File and Photo, video or audio work. */
  upload?: boolean;
  /** Open the device's file picker (`accept`: the kind's types). */
  onPickFiles?: (accept?: string) => void;
  /** The host lists stored files: the View group's Inbox opens them. */
  onInbox?: () => void;
  /** The host keeps the chat's history: the View group's History opens it. */
  onHistory?: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: Event) => {
      const el = e.target as Element | null;
      if (box.current?.contains(el) || el?.closest?.("[data-chat-attach]")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const row =
    "flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-start fs-13 disabled:cursor-default";
  const badge = "flex size-7 shrink-0 items-center justify-center rounded-full text-sm";
  const heading = "px-2.5 pb-0.5 pt-1.5 fs-10 font-semibold uppercase tracking-wide opacity-60";
  return (
    <div
      ref={box}
      role="menu"
      aria-label={attach ? t.attachOpen : t.attachGroupView}
      data-testid="debug-chat-attach-menu"
      style={{ background: "var(--lk-chat-menu-bg, oklch(0.99 0.004 85 / 0.97))" }}
      className="pointer-events-auto absolute start-0 bottom-full z-10 mb-1 w-[min(17rem,100%)] overflow-hidden rounded-2xl p-1 text-gray-800 shadow-[0_12px_32px_-10px_oklch(0.22_0.015_65/0.45)] backdrop-blur-md dark:[--lk-chat-menu-bg:oklch(0.24_0.01_65/0.97)] dark:text-gray-100"
    >
      {attach && items.length > 0 && (
        <>
          <div className={heading}>{t.attachGroupAdd}</div>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              data-testid="debug-chat-attach-add"
              data-item={it.id}
              onPointerDown={keep}
              onClick={() => {
                onClose();
                it.onPick();
              }}
              className={`${row} hover:bg-[oklch(0.5_0_0/0.08)]`}
            >
              <span
                className={badge}
                style={{ background: "oklch(0.6 0.13 30 / 0.14)", color: "oklch(0.55 0.14 30)" }}
              >
                <Icon name={iconOf(it.icon)} />
              </span>
              <span className="min-w-0 flex-1 truncate">{it.title}</span>
            </button>
          ))}
        </>
      )}
      {attach && <div className={heading}>{t.attachGroupMessage}</div>}
      {(attach ? ATTACH_KINDS : []).map((k) => {
        const soon = k.upload && !upload;
        const off = soon || (k.id === "selection" && !sel);
        return (
          <button
            key={k.id}
            type="button"
            role="menuitem"
            data-testid={`debug-chat-attach-${k.id}`}
            disabled={off}
            aria-disabled={off || undefined}
            onPointerDown={keep}
            onClick={() => {
              if (off) return;
              onClose();
              if (k.upload) return onPickFiles?.(k.accept);
              onAttachSelection();
            }}
            className={`${row} ${off ? "opacity-55" : "hover:bg-[oklch(0.5_0_0/0.08)]"}`}
          >
            <span
              className={badge}
              style={{ background: "oklch(0.6 0.11 22.3 / 0.14)", color: "oklch(0.5 0.132 22.3)" }}
            >
              {k.id === "selection" ? (
                <span aria-hidden className="font-serif text-lg leading-none">
                  “
                </span>
              ) : (
                <Icon name={k.id === "file" ? "uploadSimple" : "play"} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{t[k.label]}</span>
              {k.id === "selection" && sel && (
                <span className="block truncate fs-11 text-gray-500 dark:text-gray-400">
                  “{oneLine(sel.selection)}”
                </span>
              )}
              {k.id === "selection" && !sel && (
                <span className="block fs-11 text-gray-500 dark:text-gray-400">
                  {t.attachSelectionNone}
                </span>
              )}
            </span>
            {soon && (
              <span className="shrink-0 fs-10 leading-4 text-gray-500 dark:text-gray-400">
                {t.attachSoon}
              </span>
            )}
          </button>
        );
      })}
      <div className={heading}>{t.attachGroupView}</div>
      {onInbox && (
        <button
          type="button"
          role="menuitem"
          data-testid="debug-chat-attach-inbox"
          onPointerDown={keep}
          onClick={() => {
            onClose();
            onInbox();
          }}
          className={`${row} hover:bg-[oklch(0.5_0_0/0.08)]`}
        >
          <span
            className={badge}
            style={{ background: "oklch(0.62 0.1 80 / 0.16)", color: "oklch(0.5 0.1 80)" }}
          >
            <Icon name="uploadSimple" />
          </span>
          <span className="min-w-0 flex-1 truncate">{t.inbox}</span>
        </button>
      )}
      {onHistory && (
        <button
          type="button"
          role="menuitem"
          data-testid="debug-chat-attach-history"
          onPointerDown={keep}
          onClick={() => {
            onClose();
            onHistory();
          }}
          className={`${row} hover:bg-[oklch(0.5_0_0/0.08)]`}
        >
          <span
            aria-hidden
            className={badge}
            style={{ background: "oklch(0.6 0.11 22.3 / 0.14)", color: "oklch(0.5 0.132 22.3)" }}
          >
            <HistoryIcon />
          </span>
          <span className="min-w-0 flex-1 truncate">{t.chatHistory}</span>
        </button>
      )}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={tree}
        aria-description={sessions > 0 ? sessionsLabel : undefined}
        data-testid="debug-chat-attach-tree"
        onPointerDown={keep}
        onClick={() => {
          onClose();
          onTree();
        }}
        className={`${row} hover:bg-[oklch(0.5_0_0/0.08)]`}
      >
        <span
          className={badge}
          style={{ background: "oklch(0.62 0.12 150 / 0.14)", color: "oklch(0.5 0.12 150)" }}
        >
          <TreeIcon />
        </span>
        <span className="min-w-0 flex-1 truncate">{t.attachTree}</span>
        {sessions > 0 && (
          <span
            aria-hidden
            data-testid="debug-chat-attach-tree-evals"
            className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 fs-10 leading-none text-white tabular-nums"
            style={{ background: "oklch(0.55 0.15 30)" }}
          >
            {sessions}
          </span>
        )}
        {tree && (
          <span aria-hidden className="shrink-0 fs-11 text-gray-500 dark:text-gray-400">
            ✓
          </span>
        )}
      </button>
    </div>
  );
}

/** A quoted selection: one line, a tap shows it whole (and back). */
function Quote({ ctx, t, testid }: { ctx: ChatContext; t: ChatStrings; testid: string }) {
  const [whole, setWhole] = useState(false);
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={t.attachQuoted}
      aria-expanded={whole}
      title={ctx.title ? `${ctx.title}${ctx.path ? ` · ${ctx.path}` : ""}` : ctx.path}
      onPointerDown={keep}
      onClick={() => setWhole((w) => !w)}
      className={`pointer-events-auto block min-w-0 flex-1 text-start text-gray-600 dark:text-gray-300 ${whole ? "max-h-40 overflow-y-auto whitespace-pre-wrap break-words" : "truncate"}`}
    >
      {whole ? ctx.selection : oneLine(ctx.selection)}
    </button>
  );
}

const QUOTE_LINE = "oklch(0.6 0.11 22.3 / 0.75)";

/** Above the input: what goes with the next line, with × to drop it. */
export function AttachChip({
  t,
  ctx,
  onRemove,
  flat = false,
}: {
  t: ChatStrings;
  ctx: ChatContext;
  onRemove: () => void;
  /** Inside the typing glass: the rail alone, no tinted box of its own (one frame). */
  flat?: boolean;
}) {
  return (
    <div
      data-testid="debug-chat-attached"
      data-flat={flat || undefined}
      style={{
        borderInlineStartColor: QUOTE_LINE,
        background: flat ? undefined : "oklch(0.6 0.11 22.3 / 0.1)",
      }}
      className={`pointer-events-auto mb-1 flex items-start gap-1 border-s-2 py-1 ps-2 pe-0.5 fs-11 leading-snug ${flat ? "" : "rounded-lg backdrop-blur"}`}
    >
      <Quote ctx={ctx} t={t} testid="debug-chat-attached-text" />
      <button
        type="button"
        data-testid="debug-chat-attached-remove"
        aria-label={t.attachRemove}
        onPointerDown={keep}
        onClick={onRemove}
        className="tap-40 -my-1 shrink-0 px-1.5 text-sm leading-6 text-gray-500"
      >
        ×
      </button>
    </div>
  );
}

/** In the log, above a line sent with a selection. */
export function QuoteBlock({ t, ctx }: { t: ChatStrings; ctx: ChatContext }) {
  return (
    <span
      data-testid="debug-chat-quote"
      style={{ borderInlineStartColor: QUOTE_LINE }}
      className="my-0.5 flex max-w-full border-s-2 ps-1.5 fs-11 leading-snug"
    >
      <Quote ctx={ctx} t={t} testid="debug-chat-quote-text" />
    </span>
  );
}
