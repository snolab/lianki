"use client";

// Settings → Language: the app's UI language. The picker is LanguageSwitcher's
// account-menu row: a pick writes `lk:ui-locale` (synced as `ui.locale`,
// docs/prefs-sync.md) and the `lang` cookies, and the server puts it first on
// every device (lib/account-locale.ts).

import { useIntlayer } from "next-intlayer";
import { LanguageSwitcher } from "./LanguageSwitcher";

export function LanguageSettings({ hideHeading = false }: { hideHeading?: boolean } = {}) {
  const c = useIntlayer("language-settings");
  return (
    <section
      id="language"
      className="mb-10 max-w-xl scroll-mt-6"
      data-section="language"
      data-testid="language-settings"
    >
      {!hideHeading && <h2 className="mb-3 text-2xl font-semibold">{c.heading}</h2>}
      <div className="overflow-hidden rounded-lg border border-[oklch(0.5_0.02_250/0.35)]">
        <LanguageSwitcher variant="menu" />
      </div>
      <p className="mt-2 text-xs text-[oklch(0.45_0.02_250)] dark:text-[oklch(0.75_0.02_250)]">
        {c.help}
      </p>
    </section>
  );
}
