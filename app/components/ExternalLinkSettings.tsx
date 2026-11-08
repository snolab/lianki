"use client";

// Settings → Links to other sites: the disclaimer before another website
// (ExternalLinkGuard) on or off, and the sites it no longer asks about. Both
// follow the account (`links.confirm`, `links.trustedHosts`).

import { useCallback, useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import type { LinkTrust } from "@lianki/core/externalLink";
import {
  forgetTrustedHosts,
  LINK_CONFIRM_KEY,
  LINK_TRUST_EVENT,
  LINK_TRUSTED_KEY,
  readLinkTrust,
  setLinkConfirm,
} from "@/lib/external-link";

const QUIET =
  "min-h-11 shrink-0 rounded-full bg-[oklch(0.5_0.02_250/0.12)] px-4 text-sm font-medium hover:bg-[oklch(0.5_0.02_250/0.2)] pointer-fine:min-h-9";

export function ExternalLinkSettings() {
  const c = useIntlayer("external-link");
  const [trust, setTrust] = useState<LinkTrust>({ confirm: true, hosts: [] });

  const reload = useCallback(() => setTrust(readLinkTrust()), []);
  useEffect(() => {
    reload();
    const onApplied = (e: Event) => {
      const k = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (k === "links.confirm" || k === "links.trustedHosts") reload();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === LINK_CONFIRM_KEY || e.key === LINK_TRUSTED_KEY) reload();
    };
    window.addEventListener(PREF_APPLIED_EVENT, onApplied);
    window.addEventListener(LINK_TRUST_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, onApplied);
      window.removeEventListener(LINK_TRUST_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, [reload]);

  return (
    <section className="mb-10 max-w-xl" data-section="external-links" data-testid="external-links">
      <h2 className="mb-3 text-2xl font-semibold">{c.heading}</h2>
      <label className="mb-4 flex min-h-11 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="size-5 shrink-0 accent-[oklch(0.5_0.14_250)]"
          checked={trust.confirm}
          onChange={(e) => setLinkConfirm(e.target.checked)}
          data-testid="external-links-ask"
        />
        <span>{c.ask}</span>
      </label>
      <h3 className="mb-2 font-medium">{c.sites}</h3>
      {trust.hosts.length === 0 ? (
        <p className="text-sm opacity-80">{c.none}</p>
      ) : (
        <ul className="space-y-1">
          {trust.hosts.map((h) => (
            <li key={h} className="flex items-center gap-3 py-1">
              <span className="min-w-0 flex-1 break-all text-sm" dir="ltr">
                {h}
              </span>
              <button type="button" className={QUIET} onClick={() => forgetTrustedHosts([h])}>
                {c.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
