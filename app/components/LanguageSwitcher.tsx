"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intlayer";
import { usePathname, useRouter } from "next/navigation";
import { LANGUAGES, isSupportedLocale } from "@/lib/constants";

export function LanguageSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  const [browserLangs, setBrowserLangs] = useState<string[]>([]);
  const { locale: currentLocale } = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  // Get browser's preferred languages
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.languages) {
      // Extract language codes from browser preferences (e.g., "en-US" -> "en")
      const langs = Array.from(navigator.languages).map((lang) => lang.split("-")[0]);
      setBrowserLangs([...new Set(langs)]); // Remove duplicates
    }
  }, []);

  const handleLanguageSelect = (code: string) => {
    console.log("[LanguageSwitcher] Starting language switch to:", code);
    console.log("[LanguageSwitcher] Current pathname:", pathname);
    console.log("[LanguageSwitcher] Current locale:", currentLocale);

    // Set locale cookie for intlayer middleware (expires in 1 year)
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    document.cookie = `NEXT_LOCALE=${code}; path=/; expires=${expires.toUTCString()}; SameSite=Lax`;

    // Replace current locale in pathname with new locale
    const newPath = pathname.replace(
      /^\/(en|zh|hi|es|fr|ar|bn|pt|ru|ur|id|de|ja|sw|mr|ko)/,
      `/${code}`,
    );

    console.log("[LanguageSwitcher] Computed newPath:", newPath);
    console.log("[LanguageSwitcher] window.location.href before:", window.location.href);

    // Use window.location.href for hard navigation to ensure middleware processes the locale change
    window.location.href = newPath;

    console.log("[LanguageSwitcher] Navigation initiated");
  };

  const isSupported = isSupportedLocale;

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="text-lg font-medium hover:underline flex items-center gap-2"
        aria-label="Switch language"
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

      {/* Modal */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Select Language</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                aria-label="Close"
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

            <div className="p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {LANGUAGES.map((lang) => {
                  const isCurrent = lang.code === currentLocale;
                  const isBrowserPreferred = browserLangs.includes(lang.code);
                  const supported = isSupported(lang.code);

                  return (
                    <button
                      key={lang.code}
                      onClick={() => handleLanguageSelect(lang.code)}
                      disabled={!supported}
                      className={`
                        text-left p-3 rounded-lg transition-colors
                        ${
                          isCurrent
                            ? "bg-blue-100 dark:bg-blue-900 border-2 border-blue-500"
                            : supported
                              ? "hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600"
                              : "opacity-50 cursor-not-allowed border border-gray-200 dark:border-gray-600"
                        }
                        ${isBrowserPreferred ? "ring-2 ring-green-400 dark:ring-green-600" : ""}
                      `}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${isCurrent ? "font-bold" : "font-medium"}`}>
                            {lang.nativeName}
                          </div>
                          <div className="text-sm text-gray-600 dark:text-gray-400">
                            {lang.name}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          {isCurrent && (
                            <span className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded-full">
                              Current
                            </span>
                          )}
                          {isBrowserPreferred && !isCurrent && (
                            <span className="text-xs bg-green-500 text-white px-2 py-0.5 rounded-full">
                              Preferred
                            </span>
                          )}
                          {!supported && (
                            <span className="text-xs bg-gray-400 text-white px-2 py-0.5 rounded-full">
                              Coming Soon
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                <p>
                  <span className="inline-block w-3 h-3 rounded-full bg-green-500 mr-1" />
                  Green ring: Your browser's preferred languages
                </p>
                <p className="mt-1">
                  <span className="inline-block w-3 h-3 rounded-full bg-blue-500 mr-1" />
                  Blue background: Currently selected
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
