/**
 * The chat input's + button, its menu, the chip of what is attached, and the
 * quote shown above a sent line (attach.ts; docs/dev-debug-widget.md, "The +
 * menu"). Every button keeps the input's focus (pointerdown preventDefault),
 * so a phone's keyboard stays up and the remembered selection stays put.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ADD_ITEMS_EVENT,
  ATTACH_KINDS,
  type AddItem,
  type PageSelection,
  addItems,
  announceChatAttach,
  createSelectionMemory,
  oneLine,
} from "./attach";
import { Icon, type IconName } from "./icons";
import type { ChatContext, ChatStrings } from "./wire";

type Memory = ReturnType<typeof createSelectionMemory>;
const MEMORY = "__lkPageSelection";

/** The chat's own elements: its box (and anything portalled with the mark) and an embed's shadow host. */
const CHAT_SELECTOR = "[data-debug-chat], [data-lk-chat-host]";
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

/** The + at the start of the input; announces itself (the bottom island then drops its ＋). */
export function AttachButton({
  t,
  open,
  onToggle,
}: {
  t: ChatStrings;
  open: boolean;
  onToggle: () => void;
}) {
  useEffect(() => announceChatAttach(), []);
  return (
    <button
      type="button"
      data-chat-attach
      data-testid="debug-chat-attach"
      aria-label={t.attachOpen}
      title={t.attachOpen}
      aria-haspopup="menu"
      aria-expanded={open}
      onPointerDown={keep}
      onClick={onToggle}
      className="tap-40 flex h-8 w-10 shrink-0 items-center justify-center self-end rounded-full text-base text-gray-500 dark:text-gray-400"
    >
      <Icon name="plus" />
    </button>
  );
}

/** The + menu: "Add" (the app's items) and "Attach to message" (ATTACH_KINDS). */
export function AttachMenu({
  t,
  sel,
  items,
  onAttachSelection,
  onClose,
}: {
  t: ChatStrings;
  sel: PageSelection | null;
  items: readonly AddItem[];
  onAttachSelection: () => void;
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
      aria-label={t.attachOpen}
      data-testid="debug-chat-attach-menu"
      style={{ background: "var(--lk-chat-menu-bg, oklch(0.99 0.004 85 / 0.97))" }}
      className="pointer-events-auto absolute start-0 bottom-full z-10 mb-1 w-[min(17rem,100%)] overflow-hidden rounded-2xl border border-current/20 p-1 text-gray-800 shadow-[0_12px_32px_-10px_oklch(0.22_0.015_65/0.45)] backdrop-blur-md dark:[--lk-chat-menu-bg:oklch(0.24_0.01_65/0.97)] dark:text-gray-100"
    >
      {items.length > 0 && (
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
      <div className={heading}>{t.attachGroupMessage}</div>
      {ATTACH_KINDS.map((k) => {
        const off = k.soon || (k.id === "selection" && !sel);
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
              if (k.id !== "selection" || !sel) return;
              onAttachSelection();
              onClose();
            }}
            className={`${row} ${off ? "opacity-55" : "hover:bg-[oklch(0.5_0_0/0.08)]"}`}
          >
            <span
              className={badge}
              style={{ background: "oklch(0.6 0.1 250 / 0.14)", color: "oklch(0.5 0.12 250)" }}
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
            {k.soon && (
              <span className="shrink-0 rounded-full border border-current/25 px-1.5 fs-10 leading-4 text-gray-500 dark:text-gray-400">
                {t.attachSoon}
              </span>
            )}
          </button>
        );
      })}
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

const QUOTE_LINE = "oklch(0.6 0.1 250 / 0.75)";

/** Above the input: what goes with the next line, with × to drop it. */
export function AttachChip({
  t,
  ctx,
  onRemove,
}: {
  t: ChatStrings;
  ctx: ChatContext;
  onRemove: () => void;
}) {
  return (
    <div
      data-testid="debug-chat-attached"
      style={{ borderInlineStartColor: QUOTE_LINE, background: "oklch(0.6 0.1 250 / 0.1)" }}
      className="pointer-events-auto mb-1 flex items-start gap-1 rounded-lg border-s-2 py-1 ps-2 pe-0.5 fs-11 leading-snug backdrop-blur"
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
