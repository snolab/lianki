"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import { appHref } from "@/lib/app-locale";

interface LearnClientProps {
  locale: string;
}

type ImportSource = "recommended" | "url" | "youtube";

interface RecommendedList {
  id: string;
  title: string;
  description: string;
  blogSlug?: string; // Link to blog post instead of URLs
  tags: string[];
}

/** Languages with word lists in Lianki, and the English name AnkiWeb's search knows them by. */
const ANKI_LANGS: [code: string, english: string][] = [
  ["ja", "Japanese"],
  ["zh", "Chinese"],
  ["ko", "Korean"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ru", "Russian"],
  ["en", "English"],
];

export default function LearnClient({ locale }: LearnClientProps) {
  const t = useIntlayer("learn-page");
  const fill = (s: string, count: number) => s.replace("{count}", String(count));
  // Language names in the page's own language, from the browser: no dictionary needed.
  const languageName = (code: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const [activeTab, setActiveTab] = useState<ImportSource>("recommended");
  const [customUrl, setCustomUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [youtubeAvailable, setYoutubeAvailable] = useState(false);

  // Check if YouTube API is available
  useEffect(() => {
    fetch("/api/import/youtube/status")
      .then((res) => res.json())
      .then((data) => setYoutubeAvailable(data.available))
      .catch(() => setYoutubeAvailable(false));
  }, []);

  // Recommended learning material lists
  const recommendedLists: RecommendedList[] = [
    {
      id: "language-reactor",
      title: "Language Reactor + Lianki Workflow",
      description:
        "Turn YouTube and Netflix into your language school - learn any language through comprehensible input with dual subtitles and spaced repetition",
      blogSlug: "2026-02-27-language-reactor-lianki-workflow",
      tags: ["Language Reactor", "YouTube", "Netflix", "Workflow"],
    },
  ];

  async function handleImportFromUrl() {
    if (!customUrl.trim()) {
      setMessage({ type: "error", text: t.errors.pleaseEnterUrl.value });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      // Fetch the .txt file
      const response = await fetch(customUrl);
      if (!response.ok) throw new Error(t.errors.failedToFetchUrlList.value);

      const text = await response.text();
      const urls = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && (line.startsWith("http://") || line.startsWith("https://")));

      if (urls.length === 0) {
        throw new Error(t.errors.noValidUrlsFound.value);
      }

      // Import URLs into the system
      await importUrls(urls);
      setMessage({ type: "success", text: fill(t.success.importedUrls.value, urls.length) });
      setCustomUrl("");
    } catch (error: any) {
      setMessage({ type: "error", text: error.message || t.errors.failedToImportFromUrl.value });
    } finally {
      setLoading(false);
    }
  }

  async function handleImportFromYouTube() {
    if (!youtubeUrl.trim()) {
      setMessage({ type: "error", text: t.errors.pleaseEnterYoutubeUrl.value });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      // Extract playlist ID from URL
      const playlistIdMatch =
        youtubeUrl.match(/[&?]list=([^&]+)/) || youtubeUrl.match(/playlist\?list=([^&]+)/);

      if (!playlistIdMatch) {
        throw new Error(t.errors.invalidYoutubeUrl.value);
      }

      const playlistId = playlistIdMatch[1];

      // Call API to import playlist
      const response = await fetch("/api/import/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || t.errors.failedToImportYoutubePlaylist.value);
      }

      const data = await response.json();
      setMessage({
        type: "success",
        text: fill(t.success.importedVideos.value, data.count),
      });
      setYoutubeUrl("");
    } catch (error: any) {
      setMessage({
        type: "error",
        text: error.message || t.errors.failedToImportFromYoutube.value,
      });
    } finally {
      setLoading(false);
    }
  }

  function handleViewRecommended(list: RecommendedList) {
    // Redirect to blog post with recommended materials
    if (list.blogSlug) {
      window.location.href = `/${locale}/blog/${list.blogSlug}`;
    }
  }

  async function importUrls(urls: string[]) {
    // Batch add URLs to the user's review queue
    const response = await fetch("/api/fsrs/batch-add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || t.errors.failedToImportUrls.value);
    }

    return response.json();
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">{t.heading}</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-8">
        {t.subtitle}
        {youtubeAvailable ? t.subtitleYoutube : ""}
        {t.subtitleEnd}
      </p>

      {/* Message Display */}
      {message && (
        <div
          className={`mb-6 p-4 rounded-lg ${
            message.type === "success"
              ? "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200"
              : "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab("recommended")}
          className={`px-6 py-3 font-medium border-b-2 transition-colors ${
            activeTab === "recommended"
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
          }`}
        >
          {t.tabs.recommended}
        </button>
        <button
          onClick={() => setActiveTab("url")}
          className={`px-6 py-3 font-medium border-b-2 transition-colors ${
            activeTab === "url"
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
          }`}
        >
          {t.tabs.customUrl}
        </button>
        {youtubeAvailable && (
          <button
            onClick={() => setActiveTab("youtube")}
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === "youtube"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            }`}
          >
            {t.tabs.youtube}
          </button>
        )}
      </div>

      {/* Tab Content */}
      {activeTab === "recommended" && (
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold mb-4">{t.recommended.heading}</h2>
          {/* Shared Anki decks: AnkiWeb's library, searched per language we teach. */}
          <section
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 space-y-3"
            data-anki-decks
          >
            <h3 className="text-xl font-semibold">{t.ankiDecks.heading}</h3>
            <p className="text-gray-600 dark:text-gray-400">{t.ankiDecks.description}</p>
            <ul className="flex flex-wrap gap-2">
              {ANKI_LANGS.map(([code, english]) => (
                <li key={code}>
                  <a
                    href={`https://ankiweb.net/shared/decks?search=${encodeURIComponent(english)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block rounded-full border border-gray-300 dark:border-gray-600 px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    {languageName(code)}
                  </a>
                </li>
              ))}
              <li>
                <a
                  href="https://ankiweb.net/shared/decks"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-3 py-1 text-sm underline opacity-80"
                >
                  {t.ankiDecks.browseAll}
                </a>
              </li>
            </ul>
            <p className="text-sm">
              {t.ankiDecks.importNote}{" "}
              <Link href={appHref("/import", locale)} className="text-blue-600 hover:underline">
                {t.ankiDecks.importLink}
              </Link>
            </p>
          </section>
          {recommendedLists.map((list) => (
            <div
              key={list.id}
              className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-xl font-semibold mb-2">{list.title}</h3>
                  <p className="text-gray-600 dark:text-gray-400 mb-3">{list.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {list.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-3 py-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded-full text-sm"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => handleViewRecommended(list)}
                  className="ml-4 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  {t.recommended.viewButton}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === "url" && (
        <div>
          <h2 className="text-2xl font-semibold mb-4">{t.customUrl.heading}</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{t.customUrl.description}</p>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
            <label className="block text-sm font-medium mb-2">{t.customUrl.label}</label>
            <input
              type="url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleImportFromUrl();
                }
              }}
              placeholder="https://example.com/urls.txt"
              className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded px-4 py-2 mb-4 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            />

            <div className="bg-gray-50 dark:bg-gray-900 rounded p-4 mb-4">
              <p className="text-sm font-medium mb-2">{t.customUrl.exampleLabel}</p>
              <pre className="text-xs text-gray-600 dark:text-gray-400">
                https://example.com/article1{"\n"}
                https://example.com/article2{"\n"}
                https://example.com/article3
              </pre>
            </div>

            <button
              onClick={handleImportFromUrl}
              disabled={loading || !customUrl.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-6 py-2 rounded-lg font-medium transition-colors"
            >
              {loading ? t.customUrl.importing : t.customUrl.importButton}
            </button>
          </div>
        </div>
      )}

      {activeTab === "youtube" && (
        <div>
          <h2 className="text-2xl font-semibold mb-4">{t.youtube.heading}</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{t.youtube.description}</p>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
            <label className="block text-sm font-medium mb-2">{t.youtube.label}</label>
            <input
              type="url"
              value={youtubeUrl}
              onChange={(e) => setYoutubeUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleImportFromYouTube();
                }
              }}
              placeholder="https://www.youtube.com/playlist?list=PLxxx..."
              className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded px-4 py-2 mb-4 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            />

            <div className="bg-gray-50 dark:bg-gray-900 rounded p-4 mb-4">
              <p className="text-sm font-medium mb-2">{t.youtube.exampleLabel}</p>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                https://www.youtube.com/watch?v=OA3O1jOCnN4&list=PLCLBHbUvkRGo5AJwrulwhBmrit0-5TiXT
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
                {t.youtube.exampleNote}
              </p>
            </div>

            <button
              onClick={handleImportFromYouTube}
              disabled={loading || !youtubeUrl.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-6 py-2 rounded-lg font-medium transition-colors"
            >
              {loading ? t.youtube.importing : t.youtube.importButton}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
