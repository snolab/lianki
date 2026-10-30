"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntlayer, useLocale } from "next-intlayer";
import { usePathname } from "next/navigation";
import { notePrefWrite } from "@lianki/ui-state";
import { LOCALE_PARAM, LOCALE_PICK_KEY, isAppRoute } from "@/lib/app-locale";
import { LANGUAGES, isSupportedLocale } from "@/lib/constants";

export function LanguageSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  // The portal leaves the shell's <div lang dir>; the sheet carries them over.
  const [scope, setScope] = useState<{ lang?: string; dir?: string }>({});
  const [browserLangs, setBrowserLangs] = useState<string[]>([]);
  const { locale: currentLocale } = useLocale();
  const text = useIntlayer("language-switcher");
  const pathname = usePathname();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Get browser's preferred languages
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.languages) {
      // Extract language codes from browser preferences (e.g., "en-US" -> "en")
      const langs = Array.from(navigator.languages).map((lang) => lang.split("-")[0]);
      setBrowserLangs([...new Set(langs)]); // Remove duplicates
    }
  }, []);

  // Modal: Escape closes it, focus moves in on open and back to the trigger on close.
  useEffect(() => {
    if (!isOpen) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      trigger?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  const handleLanguageSelect = (code: string) => {
    // Remember the choice for a year: NEXT_LOCALE for the prefixed landing/blog
    // pages, `lang` for the app routes, which are otherwise bare URLs.
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    for (const name of ["NEXT_LOCALE", LOCALE_PARAM]) {
      document.cookie = `${name}=${code}; path=/; expires=${expires.toUTCString()}; SameSite=Lax`;
    }
    // A pick by hand follows the account (docs/prefs-sync.md, `ui.locale`);
    // a detected language never does.
    try {
      localStorage.setItem(LOCALE_PICK_KEY, code);
    } catch {}
    notePrefWrite();

    // App routes: an explicit switch is the one time `?lang=` goes in the URL.
    if (isAppRoute(pathname)) {
      const url = new URL(window.location.href);
      url.searchParams.set(LOCALE_PARAM, code);
      window.location.href = url.toString();
      return;
    }

    // Replace current locale in pathname with new locale
    const newPath = pathname.replace(
      /^\/(en|zh|hi|es|fr|ar|bn|pt|ru|ur|id|de|ja|sw|mr|ko)/,
      `/${code}`,
    );

    // Use window.location.href for hard navigation to ensure middleware processes the locale change
    window.location.href = newPath;
  };

  const isSupported = isSupportedLocale;

  // The picker is portalled to <body>. Rendered in place it sat inside the glass
  // header, whose backdrop-filter makes it the containing block of a fixed
  // child: the "full-screen" overlay was laid out against the 56px header and
  // the panel, centred on it, ran off the top of a phone screen (owner,
  // 2026-10-31, iPhone 414x721). Placement and sizing: .lk-lang-sheet.
  const picker = (
    <div
      lang={scope.lang}
      dir={scope.dir}
      className="lk-lang-backdrop fixed inset-0 z-[70]"
      onClick={() => setIsOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lk-lang-title"
        className="lk-lang-sheet lk-glass fixed flex flex-col rounded-2xl border border-[var(--glass-line)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--glass-line)] px-4 py-2">
          <h2 id="lk-lang-title" className="text-lg font-semibold">
            {text.title}
          </h2>
          <button
            ref={closeRef}
            onClick={() => setIsOpen(false)}
            className="-me-2 flex min-h-10 min-w-10 items-center justify-center rounded-lg opacity-70 hover:opacity-100"
            aria-label={text.close.value}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Many locales (16): the list scrolls inside the sheet, never the page. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {LANGUAGES.map((lang) => {
              const isCurrent = lang.code === currentLocale;
              const isBrowserPreferred = browserLangs.includes(lang.code);
              const supported = isSupported(lang.code);

              return (
                <button
                  key={lang.code}
                  data-lang={lang.code}
                  onClick={() => handleLanguageSelect(lang.code)}
                  disabled={!supported}
                  aria-current={isCurrent ? "true" : undefined}
                  className={`
                    lk-lang-option min-h-11 text-left px-3 py-2 rounded-lg border transition-colors
                    ${
                      isCurrent
                        ? "lk-lang-current border-2"
                        : supported
                          ? "border-[var(--glass-line)]"
                          : "opacity-50 cursor-not-allowed border-[var(--glass-line)]"
                    }
                    ${isBrowserPreferred ? "lk-lang-preferred" : ""}
                  `}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className={`${isCurrent ? "font-bold" : "font-medium"}`}>
                        {lang.nativeName}
                      </div>
                      <div className="text-sm opacity-70">{lang.name}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {isCurrent && (
                        <span className="lk-lang-badge-current text-xs px-2 py-0.5 rounded-full">
                          {text.current}
                        </span>
                      )}
                      {isBrowserPreferred && !isCurrent && (
                        <span className="lk-lang-badge-preferred text-xs px-2 py-0.5 rounded-full">
                          {text.preferred}
                        </span>
                      )}
                      {!supported && (
                        <span className="text-xs px-2 py-0.5 rounded-full border border-[var(--glass-line)]">
                          Coming Soon
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-3 text-xs opacity-70">
            <p>
              <span className="lk-lang-dot-preferred inline-block w-3 h-3 rounded-full me-1" />
              Green ring: Your browser's preferred languages
            </p>
            <p className="mt-1">
              <span className="lk-lang-dot-current inline-block w-3 h-3 rounded-full me-1" />
              Blue background: Currently selected
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        onClick={(e) => {
          const t = e.currentTarget;
          setScope({
            lang: t.closest("[lang]")?.getAttribute("lang") ?? undefined,
            dir: t.closest("[dir]")?.getAttribute("dir") ?? undefined,
          });
          setIsOpen(true);
        }}
        // A 40px hit area around the 20px glyph; -m-2.5 keeps the header compact.
        className="text-lg font-medium hover:underline flex items-center gap-2 min-h-10 min-w-10 justify-center -m-2.5 p-2.5"
        aria-label={text.switchLanguage.value}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        title={text.switchLanguage.value}
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
          />
        </svg>
        <span className="hidden sm:inline">
          {LANGUAGES.find((l) => l.code === currentLocale)?.nativeName || "Language"}
        </span>
      </button>

      {isOpen && createPortal(picker, document.body)}
    </>
  );
}
