"use client";

import { useEffect, useRef, useState } from "react";
import {
  followLink,
  guardRel,
  type LeaveRequest,
  leavingClick,
  type LinkClick,
  readLinkPolicy,
  setLeavePresenter,
  answerLeave,
} from "@/lib/external-link";
import { allowedHostOf } from "@lianki/core/externalLink";

export type ExternalLinkStrings = {
  title: string;
  disclaimer: string;
  skipSite: string;
  skipAll: string;
  savedNote: string;
  cancel: string;
  go: string;
};

const BTN =
  "min-h-11 flex-1 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.55_0.154_22.3)]";

/**
 * Every page's disclaimer before another website (owner, 2026-11-09;
 * @lianki/core/externalLink). One delegated click handler on window, in the
 * bubble phase, so a link someone already handled (preventDefault) is left
 * alone; shadow roots (the chat) are read through composedPath. Lianki's own
 * hosts never ask. Code that opens a site itself calls openExternal(), which
 * comes here through the presenter.
 *
 * Every link that leaves gets rel="noopener noreferrer", asked about or not.
 */
export function ExternalLinkGuard({ strings }: { strings: ExternalLinkStrings }) {
  const [req, setReq] = useState<LeaveRequest | null>(null);
  const [skipSite, setSkipSite] = useState(false);
  const [skipAll, setSkipAll] = useState(false);
  const goRef = useRef<HTMLButtonElement>(null);
  const backTo = useRef<Element | null>(null);

  useEffect(() => {
    const show = (r: LeaveRequest) => {
      backTo.current = document.activeElement;
      setSkipSite(false);
      setSkipAll(false);
      setReq(r);
    };
    const onClick = (e: Event) => {
      const hit = leavingClick(e as unknown as LinkClick, window.location.href, readLinkPolicy());
      if (!hit) return;
      guardRel(hit.anchor);
      if (!hit.ask) return;
      e.preventDefault();
      show({ host: hit.ask, href: hit.href, newTab: hit.newTab });
    };
    const unpresent = setLeavePresenter(show);
    window.addEventListener("click", onClick);
    window.addEventListener("auxclick", onClick);
    return () => {
      unpresent();
      window.removeEventListener("click", onClick);
      window.removeEventListener("auxclick", onClick);
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    goRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req]);

  function close() {
    setReq(null);
    try {
      (backTo.current as HTMLElement | null)?.focus?.();
    } catch {}
  }

  function go() {
    if (!req) return;
    answerLeave(req.host, { skipSite, skipAll });
    setReq(null);
    followLink(req.href, req.newTab);
  }

  if (!req) return null;
  const canAllow = allowedHostOf(req.host) !== null;

  return (
    <div
      className="fixed inset-0 z-[var(--lk-z-notice)] flex items-end justify-center bg-[oklch(0.15_0.01_65/0.5)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
      role="presentation"
      onClick={close}
      data-testid="external-link-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lk-ext-title"
        aria-describedby="lk-ext-disclaimer"
        data-testid="external-link-dialog"
        className="w-full max-w-md rounded-2xl border border-[oklch(0.5_0.02_65/0.25)] bg-[var(--background)] p-5 text-[var(--foreground)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="lk-ext-title" className="text-lg font-semibold">
          {strings.title}
        </h2>
        <p className="mt-3 break-all text-base font-semibold" data-testid="external-link-host">
          {req.host}
        </p>
        <p className="mt-1 line-clamp-2 break-all font-mono text-xs opacity-80" dir="ltr">
          {req.href}
        </p>
        <p id="lk-ext-disclaimer" className="mt-3 text-sm">
          {strings.disclaimer}
        </p>

        <div className="mt-4 space-y-1">
          {canAllow && (
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-[oklch(0.5_0.154_22.3)]"
                checked={skipSite || skipAll}
                disabled={skipAll}
                onChange={(e) => setSkipSite(e.target.checked)}
                data-testid="external-link-skip-site"
              />
              <span>{strings.skipSite}</span>
            </label>
          )}
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-5 shrink-0 accent-[oklch(0.5_0.154_22.3)]"
              checked={skipAll}
              onChange={(e) => setSkipAll(e.target.checked)}
              data-testid="external-link-skip-all"
            />
            <span>{strings.skipAll}</span>
          </label>
          {(skipSite || skipAll) && <p className="text-xs opacity-80">{strings.savedNote}</p>}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            className={`${BTN} bg-[oklch(0.5_0.02_65/0.14)] hover:bg-[oklch(0.5_0.02_65/0.22)]`}
            onClick={close}
            data-testid="external-link-cancel"
          >
            {strings.cancel}
          </button>
          <button
            ref={goRef}
            type="button"
            className={`${BTN} bg-[oklch(0.42_0.143_22.3)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.36_0.143_22.3)] dark:bg-[oklch(0.78_0.11_22.3)] dark:text-[oklch(0.18_0.02_250)] dark:hover:bg-[oklch(0.84_0.088_22.3)]`}
            onClick={go}
            data-testid="external-link-go"
          >
            {strings.go}
          </button>
        </div>
      </div>
    </div>
  );
}
