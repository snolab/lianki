"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type WordEntry = {
  id: string;
  word: string;
  definition: string;
  sentence: string;
  reading: string;
  explanation: string;
  loadingSentence: boolean;
  selected: boolean;
};

interface Props {
  locale: string;
  lang: string;
  langName: string;
  langNativeName: string;
  isLoggedIn: boolean;
}

export default function AiVocabLangClient({
  locale,
  lang: _lang,
  langName,
  langNativeName,
  isLoggedIn,
}: Props) {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [words, setWords] = useState<WordEntry[]>([]);
  const [loadingWord, setLoadingWord] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [error, setError] = useState("");

  async function fetchSentence(
    word: string,
    historySentences: string[],
  ): Promise<{ sentence: string; reading: string; explanation: string }> {
    const res = await fetch("/api/ai-sentences/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        word,
        language: langName,
        topic: topic || undefined,
        historySentences,
      }),
    });
    if (!res.ok) return { sentence: "", reading: "", explanation: "" };
    const data = await res.json();
    return {
      sentence: data.sentence || "",
      reading: data.reading || "",
      explanation: data.explanation || "",
    };
  }

  async function generateWord() {
    setLoadingWord(true);
    setError("");
    try {
      const res = await fetch("/api/ai-sentences/new-word", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic || langName,
          language: langName,
          knownWords: words.map((w) => w.word),
        }),
      });
      if (res.status === 401) {
        setError("Sign in to generate vocabulary.");
        return;
      }
      if (!res.ok) {
        const d = await res.json();
        setError(d.error || "Failed to generate word.");
        return;
      }
      const { word, definition } = await res.json();
      if (!word) {
        setError("No word returned.");
        return;
      }

      const id = `${word}-${Date.now()}`;
      const entry: WordEntry = {
        id,
        word,
        definition,
        sentence: "",
        reading: "",
        explanation: "",
        loadingSentence: true,
        selected: true,
      };
      setWords((prev) => [entry, ...prev]);

      const sentenceData = await fetchSentence(word, []);
      setWords((prev) =>
        prev.map((w) => (w.id === id ? { ...w, ...sentenceData, loadingSentence: false } : w)),
      );
    } finally {
      setLoadingWord(false);
    }
  }

  async function regenerateSentence(entry: WordEntry) {
    setWords((prev) => prev.map((w) => (w.id === entry.id ? { ...w, loadingSentence: true } : w)));
    const history = words.filter((w) => w.word === entry.word && w.sentence).map((w) => w.sentence);
    const sentenceData = await fetchSentence(entry.word, history);
    setWords((prev) =>
      prev.map((w) => (w.id === entry.id ? { ...w, ...sentenceData, loadingSentence: false } : w)),
    );
  }

  function toggleSelect(id: string) {
    setWords((prev) => prev.map((w) => (w.id === id ? { ...w, selected: !w.selected } : w)));
  }

  async function saveCards() {
    const selected = words.filter((w) => w.selected);
    if (selected.length === 0) return;
    setSaving(true);
    setSaveMessage("");
    try {
      const res = await fetch("/api/ai-sentences/save-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          words: selected.map(({ word, definition }) => ({ word, definition, language: langName })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMessage(data.error || "Failed to save.");
      } else {
        setSaveMessage(data.message || "Saved!");
        setWords((prev) => prev.map((w) => (w.selected ? { ...w, selected: false } : w)));
      }
    } finally {
      setSaving(false);
    }
  }

  const selectedCount = words.filter((w) => w.selected).length;

  return (
    <div className="max-w-2xl mx-auto p-8">
      <div className="mb-6">
        <button
          onClick={() => router.push(`/${locale}/ai-vocab`)}
          className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 mb-4 inline-flex items-center gap-1"
        >
          ← Back
        </button>
        <h1 className="text-3xl font-bold">
          {langNativeName} <span className="text-gray-400 font-normal text-xl">({langName})</span>
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">AI vocabulary practice</p>
      </div>

      <div className="flex gap-2 mb-6">
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !loadingWord && isLoggedIn && generateWord()}
          placeholder="Topic (optional, e.g. food, travel…)"
          className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 bg-transparent focus:outline-none focus:border-blue-400"
        />
        <button
          onClick={generateWord}
          disabled={loadingWord || !isLoggedIn}
          className="px-5 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loadingWord ? "Generating…" : "Generate word"}
        </button>
      </div>

      {!isLoggedIn && (
        <p className="text-amber-600 dark:text-amber-400 text-sm mb-6">
          <a href={`/${locale}/sign-in`} className="underline">
            Sign in
          </a>{" "}
          to generate vocabulary.
        </p>
      )}

      {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

      {words.length > 0 && (
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm text-gray-500">{selectedCount} selected</span>
          <button
            onClick={saveCards}
            disabled={saving || selectedCount === 0}
            className="px-4 py-1.5 text-sm bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Saving…" : `Save${selectedCount > 0 ? ` ${selectedCount}` : ""} to deck`}
          </button>
        </div>
      )}

      {saveMessage && (
        <p className="text-green-600 dark:text-green-400 text-sm mb-4">{saveMessage}</p>
      )}

      <div className="space-y-4">
        {words.map((entry) => (
          <div
            key={entry.id}
            className={`border rounded-lg p-4 transition-colors ${
              entry.selected
                ? "border-blue-400 bg-blue-50 dark:bg-blue-950/20"
                : "border-gray-200 dark:border-gray-700"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <input
                  type="checkbox"
                  checked={entry.selected}
                  onChange={() => toggleSelect(entry.id)}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-500 cursor-pointer"
                />
                <div className="min-w-0">
                  <span className="text-xl font-bold">{entry.word}</span>
                  {entry.definition && (
                    <span className="ml-2 text-gray-500 dark:text-gray-400 text-sm">
                      {entry.definition}
                    </span>
                  )}
                  {entry.loadingSentence ? (
                    <p className="text-sm text-gray-400 mt-2 animate-pulse">Generating sentence…</p>
                  ) : entry.sentence ? (
                    <div className="mt-2 space-y-1">
                      <p className="text-gray-800 dark:text-gray-200">{entry.sentence}</p>
                      {entry.reading && (
                        <p className="text-sm text-gray-500 dark:text-gray-400">{entry.reading}</p>
                      )}
                      {entry.explanation && (
                        <p className="text-xs text-gray-400 italic">{entry.explanation}</p>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
              {!entry.loadingSentence && (
                <button
                  onClick={() => regenerateSentence(entry)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0 mt-1"
                  title="Generate another sentence"
                >
                  ↻
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {words.length === 0 && isLoggedIn && (
        <p className="text-center text-gray-400 dark:text-gray-500 text-sm mt-12">
          Press &ldquo;Generate word&rdquo; to start learning {langNativeName} vocabulary.
        </p>
      )}
    </div>
  );
}
