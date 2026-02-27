"use client";

import { useState, useEffect } from "react";
import { useIntlayer } from "next-intlayer";

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

export default function LearnClient({ locale }: LearnClientProps) {
  const {
    heading,
    subtitle,
    subtitleYoutube,
    subtitleEnd,
    tabs,
    recommended,
    customUrl: customUrlContent,
    youtube: youtubeContent,
    errors,
    success,
  } = useIntlayer("learn-page");

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
      id: "japanese-beginner",
      title: "Japanese for Beginners",
      description:
        "Curated learning materials for Japanese beginners - from hiragana to basic conversations",
      blogSlug: "2026-02-25-japanese-beginner-materials",
      tags: ["Japanese", "Beginner", "N5"],
    },
  ];

  async function handleImportFromUrl() {
    if (!customUrl.trim()) {
      setMessage({ type: "error", text: errors.pleaseEnterUrl });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      // Fetch the .txt file
      const response = await fetch(customUrl);
      if (!response.ok) throw new Error(errors.failedToFetchUrlList);

      const text = await response.text();
      const urls = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && (line.startsWith("http://") || line.startsWith("https://")));

      if (urls.length === 0) {
        throw new Error(errors.noValidUrlsFound);
      }

      // Import URLs into the system
      await importUrls(urls);
      setMessage({ type: "success", text: success.importedUrls.replace("{count}", urls.length.toString()) });
      setCustomUrl("");
    } catch (error: any) {
      setMessage({ type: "error", text: error.message || errors.failedToImportFromUrl });
    } finally {
      setLoading(false);
    }
  }

  async function handleImportFromYouTube() {
    if (!youtubeUrl.trim()) {
      setMessage({ type: "error", text: errors.pleaseEnterYoutubeUrl });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      // Extract playlist ID from URL
      const playlistIdMatch =
        youtubeUrl.match(/[&?]list=([^&]+)/) || youtubeUrl.match(/playlist\?list=([^&]+)/);

      if (!playlistIdMatch) {
        throw new Error(errors.invalidYoutubeUrl);
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
        throw new Error(error.message || errors.failedToImportYoutubePlaylist);
      }

      const data = await response.json();
      setMessage({
        type: "success",
        text: success.importedVideos.replace("{count}", data.count.toString()),
      });
      setYoutubeUrl("");
    } catch (error: any) {
      setMessage({ type: "error", text: error.message || errors.failedToImportFromYoutube });
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
      throw new Error(error.message || errors.failedToImportUrls);
    }

    return response.json();
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">{heading}</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-8">
        {subtitle}
        {youtubeAvailable ? subtitleYoutube : ""}{subtitleEnd}
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
          {tabs.recommended}
        </button>
        <button
          onClick={() => setActiveTab("url")}
          className={`px-6 py-3 font-medium border-b-2 transition-colors ${
            activeTab === "url"
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
          }`}
        >
          {tabs.customUrl}
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
            {tabs.youtube}
          </button>
        )}
      </div>

      {/* Tab Content */}
      {activeTab === "recommended" && (
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold mb-4">{recommended.heading}</h2>
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
                  {recommended.viewButton}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === "url" && (
        <div>
          <h2 className="text-2xl font-semibold mb-4">{customUrlContent.heading}</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {customUrlContent.description}
          </p>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
            <label className="block text-sm font-medium mb-2">{customUrlContent.label}</label>
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
              placeholder={customUrlContent.placeholder}
              className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded px-4 py-2 mb-4 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            />

            <div className="bg-gray-50 dark:bg-gray-900 rounded p-4 mb-4">
              <p className="text-sm font-medium mb-2">{customUrlContent.exampleLabel}</p>
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
              {loading ? customUrlContent.importing : customUrlContent.importButton}
            </button>
          </div>
        </div>
      )}

      {activeTab === "youtube" && (
        <div>
          <h2 className="text-2xl font-semibold mb-4">{youtubeContent.heading}</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {youtubeContent.description}
          </p>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
            <label className="block text-sm font-medium mb-2">{youtubeContent.label}</label>
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
              placeholder={youtubeContent.placeholder}
              className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded px-4 py-2 mb-4 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            />

            <div className="bg-gray-50 dark:bg-gray-900 rounded p-4 mb-4">
              <p className="text-sm font-medium mb-2">{youtubeContent.exampleLabel}</p>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                https://www.youtube.com/watch?v=OA3O1jOCnN4&list=PLCLBHbUvkRGo5AJwrulwhBmrit0-5TiXT
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
                {youtubeContent.exampleNote}
              </p>
            </div>

            <button
              onClick={handleImportFromYouTube}
              disabled={loading || !youtubeUrl.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-6 py-2 rounded-lg font-medium transition-colors"
            >
              {loading ? youtubeContent.importing : youtubeContent.importButton}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
