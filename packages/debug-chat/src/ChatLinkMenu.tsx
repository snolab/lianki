/** The chat's link actions. Native popover stays in the widget's style root. */
import { useEffect, useRef, useState } from "react";
import { chatExtra } from "./chat-ui-locales";

/**
 * Use an ordinary anchor outside the message tree: the host's existing
 * ExternalLinkGuard sees this click and keeps all account bypass rules.
 * No app imports or new permission path in the standalone chat package.
 */
export function openChatLink(href: string, onOpenPage?: (path: string) => void) {
  const url = new URL(href, location.href);
  if (!/^https?:$/.test(url.protocol)) return;
  if (url.origin === location.origin && onOpenPage) {
    onOpenPage(`${url.pathname}${url.search}${url.hash}`);
    return;
  }
  const link = document.createElement("a");
  link.href = url.href;
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function ChatLinkMenu({
  href,
  prod,
  forceProd,
  onOpenPage,
  onClose,
}: {
  href: string;
  prod: string | null;
  forceProd: boolean;
  onOpenPage?: (path: string) => void;
  onClose: () => void;
}) {
  const t = chatExtra();
  const popup = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("");
  const [native, setNative] = useState(
    typeof navigator === "undefined" || typeof navigator.share !== "function",
  );
  useEffect(() => {
    const el = popup.current;
    el?.showPopover();
    el?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    return () => el?.hidePopover();
  }, []);
  const go = (url: string) => {
    onClose();
    openChatLink(url, onOpenPage);
  };
  const row =
    "min-h-11 w-full rounded-xl px-3 py-2 text-start fs-14 hover:bg-[oklch(0.5_0.02_250/0.1)] focus-visible:outline-2 focus-visible:outline-offset-[-2px]";
  return (
    <div
      ref={popup}
      popover="auto"
      role="menu"
      aria-label={t.linkMenuTitle}
      data-testid="chat-link-menu"
      onToggle={(e) => {
        if (e.newState === "closed") onClose();
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }}
      style={{
        inset: "auto",
        left: "50%",
        bottom: "max(1rem, env(safe-area-inset-bottom))",
        transform: "translateX(-50%)",
        background: "light-dark(oklch(0.98 0.01 85), oklch(0.24 0.01 250))",
        color: "light-dark(oklch(0.25 0.01 250), oklch(0.94 0.01 85))",
      }}
      className="pointer-events-auto fixed m-0 w-[min(24rem,calc(100vw-2rem))] max-h-[80dvh] overflow-auto rounded-2xl border border-[oklch(0.5_0.02_250/0.3)] p-3 shadow-xl backdrop:bg-[oklch(0.15_0.01_65/0.4)]"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 font-semibold fs-14">{t.linkMenuTitle}</span>
        <button
          type="button"
          className="size-11 shrink-0"
          aria-label={t.linkClose}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="mb-2 max-h-20 overflow-auto break-all opacity-70 fs-11">{href}</p>
      <button
        type="button"
        role="menuitem"
        data-testid="chat-link-open"
        className={row}
        onClick={() => go(href)}
      >
        {forceProd ? t.linkOpenProd : prod ? t.linkOpenHere : t.linkOpen}
      </button>
      {prod && (
        <button
          type="button"
          role="menuitem"
          data-testid="chat-link-prod"
          className={row}
          onClick={() => go(prod)}
        >
          {t.linkOpenProd}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        data-testid="chat-link-copy"
        className={row}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(new URL(href, location.href).href);
            setStatus(t.linkCopied);
          } catch {
            setStatus(t.linkCopyFailed);
          }
        }}
      >
        {t.linkCopy}
      </button>
      {native ? (
        <a
          href={href}
          role="menuitem"
          data-testid="chat-link-system-native"
          className={`${row} block underline`}
          title={t.linkSystemHint}
          onClick={(e) => {
            e.preventDefault();
            go(href);
          }}
        >
          {t.linkSystem}
          <span className="block opacity-70 fs-11">{t.linkSystemHint}</span>
        </a>
      ) : (
        <button
          type="button"
          role="menuitem"
          data-testid="chat-link-system"
          className={row}
          onClick={async () => {
            try {
              await navigator.share({ url: new URL(href, location.href).href });
              onClose();
            } catch (error: unknown) {
              if ((error as { name?: string })?.name === "AbortError") onClose();
              else setNative(true);
            }
          }}
        >
          {t.linkSystem}
        </button>
      )}
      {status && (
        <p role="status" className="mt-2 fs-12">
          {status}
        </p>
      )}
    </div>
  );
}
