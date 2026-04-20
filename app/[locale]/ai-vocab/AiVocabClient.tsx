"use client";

import { useIntlayer } from "next-intlayer";
import { useRouter } from "next/navigation";

const LANGUAGES = [
  { code: "ja", name: "日本語", nativeName: "Japanese" },
  { code: "zh", name: "中文", nativeName: "Chinese (Mandarin)" },
  { code: "ko", name: "한국어", nativeName: "Korean" },
  { code: "en", name: "English", nativeName: "English" },
  { code: "es", name: "Español", nativeName: "Spanish" },
  { code: "fr", name: "Français", nativeName: "French" },
  { code: "de", name: "Deutsch", nativeName: "German" },
  { code: "it", name: "Italiano", nativeName: "Italian" },
  { code: "pt", name: "Português", nativeName: "Portuguese" },
  { code: "ru", name: "Русский", nativeName: "Russian" },
  { code: "ar", name: "العربية", nativeName: "Arabic" },
  { code: "hi", name: "हिन्दी", nativeName: "Hindi" },
];

interface AiVocabClientProps {
  locale: string;
}

export default function AiVocabClient({ locale }: AiVocabClientProps) {
  const { title, description, selectLanguage } = useIntlayer("ai-vocab-page");
  const router = useRouter();

  function handleSelectLanguage(langCode: string) {
    router.push(`/${locale}/ai-vocab/${langCode}`);
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-4xl font-bold mb-4">{title}</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-8">{description}</p>

      <h2 className="text-2xl font-semibold mb-6">{selectLanguage}</h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            onClick={() => handleSelectLanguage(lang.code)}
            className="flex flex-col items-center justify-center p-6 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-blue-500 hover:shadow-md transition-all text-center"
          >
            <span className="text-2xl font-bold mb-1">{lang.name}</span>
            <span className="text-sm text-gray-500 dark:text-gray-400">{lang.nativeName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
