"use client";

// Settings → the "Don't ask again" choices (lib/dont-ask.ts): each one, when
// it was chosen and when it asks again, with Keep / Ask again now per row and
// for all. They follow the account (`asks.dontAsk`).

import { useCallback, useEffect, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import {
  askAgainNow,
  chooseDontAsk,
  DONT_ASK_CONFIG,
  DONT_ASK_EVENT,
  DONT_ASK_KEY,
  dayOf,
  dayStart,
  dontAskRows,
  type DontAskKind,
  type DontAskRow,
  readDontAsk,
  reviewAll,
} from "@/lib/dont-ask";
import { LINK_POLICY_EVENT } from "@/lib/external-link";
import { longDate } from "@/lib/dates";

const QUIET =
  "min-h-11 shrink-0 rounded-full bg-[oklch(0.5_0.02_250/0.12)] px-4 text-sm font-medium hover:bg-[oklch(0.5_0.02_250/0.2)] disabled:opacity-40 pointer-fine:min-h-9";
const SEAL =
  "min-h-11 shrink-0 rounded-full bg-[oklch(0.42_0.143_22.3)] px-4 text-sm font-medium text-[oklch(0.99_0_0)] hover:bg-[oklch(0.36_0.143_22.3)] dark:bg-[oklch(0.78_0.11_22.3)] dark:text-[oklch(0.18_0.02_250)] dark:hover:bg-[oklch(0.84_0.088_22.3)] pointer-fine:min-h-9";

export function DontAskReview() {
  const c = useIntlayer("dont-ask");
  const { locale } = useLocale();
  const [rows, setRows] = useState<DontAskRow[]>([]);

  const reload = useCallback(() => setRows(dontAskRows(readDontAsk(), dayOf(Date.now()))), []);
  useEffect(() => {
    reload();
    const onApplied = (e: Event) => {
      const k = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (!k || k === "asks.dontAsk") reload();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === DONT_ASK_KEY) reload();
    };
    window.addEventListener(PREF_APPLIED_EVENT, onApplied);
    window.addEventListener(DONT_ASK_EVENT, reload);
    window.addEventListener(LINK_POLICY_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, onApplied);
      window.removeEventListener(DONT_ASK_EVENT, reload);
      window.removeEventListener(LINK_POLICY_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, [reload]);

  const kindName: Record<DontAskKind, string> = {
    "link-any": c.kindLinkAny.value,
    "link-site": c.kindLinkSite.value,
    "read-polish": c.kindReadPolish.value,
  };
  const date = (day: number) => longDate(dayStart(day), locale);
  const ids = rows.map((r) => r.id);

  return (
    <section className="mb-10 max-w-xl" data-section="dont-ask" data-testid="dont-ask">
      <h2 className="mb-3 text-2xl font-semibold">{c.heading}</h2>
      <p className="mb-4 text-sm opacity-80">
        {c.intro.value.replace("{days}", String(DONT_ASK_CONFIG.reaskDays[0]))}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm opacity-80" data-testid="dont-ask-none">
          {c.none}
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={SEAL}
              onClick={() => reviewAll(ids, true)}
              data-testid="dont-ask-keep-all"
            >
              {c.keepAll}
            </button>
            <button
              type="button"
              className={QUIET}
              onClick={() => reviewAll(ids, false)}
              data-testid="dont-ask-ask-all"
            >
              {c.askAll}
            </button>
          </div>
          <ul className="divide-y divide-[oklch(0.5_0.02_250/0.18)]">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
                data-testid="dont-ask-row"
                data-id={r.id}
                data-due={r.isDue || undefined}
              >
                <div className="min-w-0 flex-[1_1_12rem]">
                  <p className="text-sm font-medium">{kindName[r.kind]}</p>
                  {r.subject && (
                    <p className="break-all font-mono text-xs" dir="ltr">
                      {r.subject}
                    </p>
                  )}
                  <p className="text-xs opacity-80">
                    {c.chosen.value.replace("{date}", date(r.chosen))}
                    {" · "}
                    {r.isDue ? (
                      <span className="font-medium text-[oklch(0.45_0.143_22.3)] dark:text-[oklch(0.8_0.11_22.3)]">
                        {c.due}
                      </span>
                    ) : (
                      c.next.value.replace("{date}", date(r.due))
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={QUIET}
                    onClick={() => askAgainNow(r.id)}
                    disabled={r.isDue}
                    data-testid="dont-ask-ask-now"
                  >
                    {c.askNow}
                  </button>
                  <button
                    type="button"
                    className={SEAL}
                    onClick={() => chooseDontAsk(r.id)}
                    data-testid="dont-ask-keep"
                  >
                    {c.keep}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
