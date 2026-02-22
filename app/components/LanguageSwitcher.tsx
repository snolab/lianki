"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intlayer";
import { Locales } from "intlayer";

type Language = {
  code: string;
  name: string;
  nativeName: string;
};

// Available languages using Intlayer's Locales constants
// Extend this list as more languages are added to intlayer.config.ts
const LANGUAGES: Language[] = [
  { code: Locales.ENGLISH, name: "English", nativeName: "English" },
  { code: Locales.CHINESE_SIMPLIFIED, name: "Chinese (Simplified)", nativeName: "简体中文" },
  { code: Locales.JAPANESE, name: "Japanese", nativeName: "日本語" },
  { code: Locales.HINDI, name: "Hindi", nativeName: "हिन्दी" },
  { code: Locales.SPANISH, name: "Spanish", nativeName: "Español" },
  { code: Locales.FRENCH, name: "French", nativeName: "Français" },
  { code: Locales.ARABIC, name: "Arabic", nativeName: "العربية" },
  { code: Locales.BENGALI, name: "Bengali", nativeName: "বাংলা" },
  { code: Locales.PORTUGUESE, name: "Portuguese", nativeName: "Português" },
  { code: Locales.RUSSIAN, name: "Russian", nativeName: "Русский" },
  { code: Locales.URDU, name: "Urdu", nativeName: "اردو" },
  { code: Locales.INDONESIAN, name: "Indonesian", nativeName: "Bahasa Indonesia" },
  { code: Locales.GERMAN, name: "German", nativeName: "Deutsch" },
  { code: Locales.SWAHILI, name: "Swahili", nativeName: "Kiswahili" },
  { code: Locales.MARATHI, name: "Marathi", nativeName: "मराठी" },
  { code: Locales.KOREAN, name: "Korean", nativeName: "한국어" },
];

export function LanguageSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  const [browserLangs, setBrowserLangs] = useState<string[]>([]);
  const { locale: currentLocale, setLocale } = useLocale();

  // Get browser's preferred languages
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.languages) {
      // Extract language codes from browser preferences (e.g., "en-US" -> "en")
      const langs = Array.from(navigator.languages).map((lang) => lang.split("-")[0]);
      setBrowserLangs([...new Set(langs)]); // Remove duplicates
    }
  }, []);

  const handleLanguageSelect = (code: string) => {
    setLocale(code);
    setIsOpen(false);
  };

  const isSupported = (code: string) => code === "en" || code === "zh" || code === "ja";

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
