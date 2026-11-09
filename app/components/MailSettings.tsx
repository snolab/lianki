"use client";

// Settings → Email (#mail): which mails the account gets (docs/mail-templates.md,
// "Unsubscribe"; lib/mail-templates/kinds.ts). Sign-in codes and account
// notices are always sent; the security notice after a sign-in from a new
// browser can be turned off here only, after a short warning. Follows the
// account (`mail.loginNotice`); the server checks it at every send.

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import { Icon } from "@/app/components/icons";
import {
  MAIL_LOGIN_NOTICE_KEY,
  MAIL_PREFS_EVENT,
  readLoginNoticeOn,
  writeLoginNoticeOn,
} from "@/lib/mail-prefs";

const BTN =
  "min-h-11 rounded-full px-4 text-sm font-medium pointer-fine:min-h-9 focus-visible:outline-2 focus-visible:outline-offset-2";

export function MailSettings() {
  const c = useIntlayer("mail-settings");
  const [on, setOn] = useState(true);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const read = () => setOn(readLoginNoticeOn());
    read();
    const onApplied = (e: Event) => {
      if ((e as CustomEvent<{ key?: string }>).detail?.key === "mail.loginNotice") read();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === MAIL_LOGIN_NOTICE_KEY) read();
    };
    window.addEventListener(PREF_APPLIED_EVENT, onApplied);
    window.addEventListener(MAIL_PREFS_EVENT, read);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, onApplied);
      window.removeEventListener(MAIL_PREFS_EVENT, read);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const set = (v: boolean) => {
    writeLoginNoticeOn(v);
    setOn(v);
    setAsking(false);
  };

  return (
    <section
      id="mail"
      className="mb-10 max-w-xl scroll-mt-20"
      data-section="mail"
      data-testid="mail-settings"
    >
      <h2 className="mb-3 text-2xl font-semibold">{c.heading}</h2>
      <p className="mb-4 text-sm opacity-80">{c.alwaysSent}</p>
      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-5 shrink-0 accent-[oklch(0.53_0.207_22.3)]"
          checked={on}
          onChange={(e) => (e.target.checked ? set(true) : setAsking(true))}
          data-testid="mail-login-notice"
        />
        <span>
          <span className="block font-medium">{c.loginNotice}</span>
          <span className="block text-sm opacity-80">{c.loginNoticeHint}</span>
        </span>
      </label>
      {asking && (
        <div
          role="alertdialog"
          aria-labelledby="mail-off-warning"
          className="mt-3 rounded-lg border border-[oklch(0.72_0.12_80)] bg-[oklch(0.96_0.04_88)] p-4 text-[oklch(0.3_0.05_70)] dark:bg-[oklch(0.27_0.04_80)] dark:text-[oklch(0.92_0.05_85)]"
          data-testid="mail-off-warning"
        >
          <p id="mail-off-warning" className="mb-3 flex gap-2">
            <Icon name="lock" className="mt-0.5 size-5 shrink-0" />
            <span>
              <span className="block font-semibold">{c.warningTitle}</span>
              <span className="block text-sm">{c.warning}</span>
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${BTN} bg-[oklch(0.53_0.207_22.3)] text-[oklch(0.99_0.005_85)]`}
              onClick={() => setAsking(false)}
              data-testid="mail-keep-on"
            >
              {c.keepOn}
            </button>
            <button
              type="button"
              className={`${BTN} bg-[oklch(0.5_0.02_70/0.15)]`}
              onClick={() => set(false)}
              data-testid="mail-turn-off"
            >
              {c.turnOff}
            </button>
          </div>
        </div>
      )}
      {!on && !asking && (
        <p className="mt-2 text-sm opacity-80" data-testid="mail-login-notice-off">
          {c.offNote}
        </p>
      )}
    </section>
  );
}
