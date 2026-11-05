"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { TITLE_MAX } from "@/lib/read/title";

const item =
  "w-full flex items-center gap-2 px-3 min-h-11 text-start text-sm rounded-md outline-none focus-visible:bg-[oklch(0.95_0.01_260)] hover:bg-[oklch(0.95_0.01_260)] dark:focus-visible:bg-[oklch(0.32_0.02_260)] dark:hover:bg-[oklch(0.32_0.02_260)]";

/**
 * The "⋯" menu on a /read row: Rename and Delete. A menu button (WAI-ARIA
 * menu pattern): Enter/Space/↓ opens on the first item, ↑ on the last,
 * arrows and Home/End move, Esc or Tab closes, focus returns to the button.
 * 44 px targets.
 */
export function RowMenu(p: { title: string; onRename: () => void; onDelete: () => void }) {
  const t = useIntlayer("read-row-menu");
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  const focusAt = (i: number) => {
    const all = items();
    all[(i + all.length) % all.length]?.focus();
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // Close on a press anywhere else.
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!menu.current?.contains(n) && !button.current?.contains(n)) setOpen(false);
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [open]);

  const openAt = (i: number) => {
    setOpen(true);
    requestAnimationFrame(() => focusAt(i));
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={button}
        type="button"
        data-testid="read-row-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={t.more.value.replace("{title}", p.title)}
        onClick={() => (open ? close() : openAt(0))}
        onKeyDown={(e) => {
          const at = { ArrowDown: 0, ArrowUp: -1 }[e.key];
          if (at === undefined) return;
          e.preventDefault();
          openAt(at);
        }}
        className="flex items-center justify-center w-11 h-11 rounded-full text-[oklch(0.55_0.02_260)] dark:text-[oklch(0.72_0.02_260)] hover:bg-[oklch(0.94_0.01_260)] dark:hover:bg-[oklch(0.32_0.02_260)] focus-visible:outline-2 focus-visible:outline-[oklch(0.55_0.18_255)]"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={p.title}
          data-testid="read-row-menu-list"
          onKeyDown={(e) => {
            const all = items();
            const at = all.indexOf(document.activeElement as HTMLElement);
            if (e.key === "Tab") return close(false);
            if (e.key === "Escape") {
              e.preventDefault();
              return close();
            }
            const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: -1 }[e.key];
            if (to === undefined) return;
            e.preventDefault();
            focusAt(to);
          }}
          className="absolute end-0 top-full z-20 mt-1 min-w-40 p-1 rounded-lg border border-[oklch(0.9_0.01_260)] dark:border-[oklch(0.38_0.02_260)] bg-[oklch(0.99_0.003_260)] dark:bg-[oklch(0.24_0.015_260)] shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid="read-row-rename"
            className={item}
            onClick={() => {
              close(false);
              p.onRename();
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            {t.rename}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid="read-row-delete"
            className={`${item} text-[oklch(0.55_0.2_27)] dark:text-[oklch(0.72_0.16_27)]`}
            onClick={() => {
              close();
              p.onDelete();
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
            </svg>
            {t.delete}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The title as a text field on its row while renaming: Enter (or Save)
 * saves, Esc (or Cancel) leaves the old one. `onSave` resolves false when
 * saving failed; the field stays open with the error.
 */
export function TitleEditor(p: {
  initial: string;
  onSave: (title: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const t = useIntlayer("read-row-menu");
  const [value, setValue] = useState(p.initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function save() {
    const v = value.trim();
    if (!v || v === p.initial) return p.onDone();
    setBusy(true);
    setFailed(false);
    const ok = await p.onSave(v);
    setBusy(false);
    if (ok) p.onDone();
    else setFailed(true);
  }

  const small =
    "shrink-0 px-3 min-h-11 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
  return (
    <form
      className="flex-1 min-w-0"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={input}
          data-testid="read-row-title-input"
          aria-label={t.titleLabel.value}
          value={value}
          maxLength={TITLE_MAX}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            p.onDone();
          }}
          className="flex-1 min-w-0 px-2 min-h-11 rounded-md border border-[oklch(0.8_0.02_260)] dark:border-[oklch(0.45_0.02_260)] bg-[oklch(1_0_0)] dark:bg-[oklch(0.22_0.01_260)] focus:outline-2 focus:outline-[oklch(0.55_0.18_255)]"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className={`${small} bg-[oklch(0.55_0.18_255)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.18_255)]`}
        >
          {t.save}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={p.onDone}
          className={`${small} text-[oklch(0.45_0.02_260)] dark:text-[oklch(0.78_0.02_260)] hover:bg-[oklch(0.94_0.01_260)] dark:hover:bg-[oklch(0.32_0.02_260)]`}
        >
          {t.cancel}
        </button>
      </div>
      {failed && (
        <p
          role="alert"
          className="mt-1 text-xs text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]"
        >
          {t.renameFailed}
        </p>
      )}
    </form>
  );
}
