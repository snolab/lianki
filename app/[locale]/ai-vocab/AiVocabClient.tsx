"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Language = {
  code: string;
  name: string;
  nativeName: string;
};

const LANGUAGES: Language[] = [
  { code: "ja-JP", name: "Japanese", nativeName: "日本語" },
  { code: "zh-CN", name: "Chinese (Mandarin)", nativeName: "中文" },
  { code: "ko-KR", name: "Korean", nativeName: "한국어" },
  { code: "en-US", name: "English", nativeName: "English" },
  { code: "es-ES", name: "Spanish", nativeName: "Español" },
  { code: "fr-FR", name: "French", nativeName: "Français" },
  { code: "de-DE", name: "German", nativeName: "Deutsch" },
  { code: "it-IT", name: "Italian", nativeName: "Italiano" },
  { code: "pt-BR", name: "Portuguese", nativeName: "Português" },
  { code: "ru-RU", name: "Russian", nativeName: "Русский" },
  { code: "ar-SA", name: "Arabic", nativeName: "العربية" },
  { code: "hi-IN", name: "Hindi", nativeName: "हिन्दी" },
];

type WordEntry = {
  word: string;
  definition: string;
  cardId?: string;
};

type SentenceItem = {
  id: string;
  word: string;
  sentence: string;
  reading: string;
  explanation: string;
};

export default function AiVocabClient() {
  const [language, setLanguage] = useState<Language | null>(null);
  const [topic, setTopic] = useState("daily conversation");
  const [words, setWords] = useState<WordEntry[]>([]);
  const [queue, setQueue] = useState<SentenceItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [isGeneratingWord, setIsGeneratingWord] = useState(false);
  const [isGeneratingSentence, setIsGeneratingSentence] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const generateSentence = useCallback(
    async (word: string) => {
      if (!language) return;
      setIsGeneratingSentence(true);
      try {
        const res = await fetch("/api/ai-sentences/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            word,
            language: language.name,
            topic,
            historySentences: queueRef.current.map((s) => s.sentence),
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to generate");
        }
        const data = await res.json();
        const item: SentenceItem = {
          id: crypto.randomUUID(),
          word: data.word || word,
          sentence: data.sentence,
          reading: data.reading,
          explanation: data.explanation,
        };
        setQueue((prev) => [...prev, item]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to generate sentence");
      } finally {
        setIsGeneratingSentence(false);
      }
    },
    [language, topic],
  );

  const addNewWord = useCallback(async () => {
    if (!language) return;
    setIsGeneratingWord(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-sentences/new-word", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          language: language.name,
          knownWords: words.map((w) => w.word),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to generate word");
      }
      const data = await res.json();
      const entry: WordEntry = { word: data.word, definition: data.definition };
      setWords((prev) => [...prev, entry]);

      // Save card
      await fetch("/api/ai-sentences/save-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          words: [{ word: data.word, definition: data.definition, language: language.code }],
        }),
      });

      // Generate first sentence for this word
      await generateSentence(data.word);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add word");
    } finally {
      setIsGeneratingWord(false);
    }
  }, [language, topic, words, generateSentence]);

  // Auto-generate sentences when queue is low
  useEffect(() => {
    if (queue.length < 3 && words.length > 0 && !isGeneratingSentence && language) {
      // Pick a word that needs practice (round-robin through words)
      const word = words[queue.length % words.length];
      if (word) generateSentence(word.word);
    }
  }, [queue.length, words, isGeneratingSentence, language, generateSentence]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

      const current = queue[activeIndex];
      if (!current) return;

      // Rating: 1=Again, 2=Hard, 3=Good, 4=Easy
      if (e.code === "Digit1" || e.code === "KeyD" || e.code === "KeyL") {
        e.preventDefault();
        rateSentence(current.id, 1);
      }
      if (e.code === "Digit2" || e.code === "KeyS" || e.code === "KeyJ") {
        e.preventDefault();
        rateSentence(current.id, 2);
      }
      if (e.code === "Digit3") {
        e.preventDefault();
        rateSentence(current.id, 3);
      }
      if (e.code === "Digit4" || e.code === "KeyA" || e.code === "KeyH") {
        e.preventDefault();
        rateSentence(current.id, 4);
      }

      // Navigation
      if (e.code === "ArrowUp" || e.code === "KeyI") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
      }
      if (e.code === "ArrowDown" || e.code === "KeyU") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(queue.length - 1, i + 1));
      }

      // Toggle details
      if (e.code === "ArrowRight" || e.code === "KeyO") {
        e.preventDefault();
        setShowDetails(true);
      }
      if (e.code === "ArrowLeft" || e.code === "KeyY") {
        e.preventDefault();
        setShowDetails(false);
      }

      // Delete word: 5/m/t
      if (e.code === "Digit5" || e.code === "KeyM" || e.code === "KeyT") {
        e.preventDefault();
        deleteWord(current.word);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [queue, activeIndex]);

  const rateSentence = (sentenceId: string, rating: number) => {
    setQueue((prev) => prev.filter((s) => s.id !== sentenceId));
    setActiveIndex((i) => Math.min(i, Math.max(0, queue.length - 2)));
  };

  const deleteWord = (word: string) => {
    setWords((prev) => prev.filter((w) => w.word !== word));
    setQueue((prev) => prev.filter((s) => s.word !== word));
  };

  const playTTS = async (text: string) => {
    if (!language) return;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language: language.code }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        audio.play();
      }
    } catch {
      // TTS is optional, fail silently
    }
  };

  // Language selection screen
  if (!language) {
    return (
      <div className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold mb-4">AI Vocabulary Practice</h1>
          <p className="text-lg mb-8 text-gray-600 dark:text-gray-400">
            Learn vocabulary with AI-generated contextual sentences
          </p>
          <h2 className="text-2xl font-semibold mb-4">Select Target Language</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => setLanguage(lang)}
                className="p-4 border-2 border-gray-300 rounded-lg hover:border-blue-400 transition-colors"
              >
                <div className="font-semibold text-lg">{lang.nativeName}</div>
                <div className="text-sm text-gray-600 dark:text-gray-400">{lang.name}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const currentSentence = queue[activeIndex];

  return (
    <div className="flex h-[calc(100vh-73px)]">
      {/* Left sidebar: word list */}
      <div className="w-64 border-r border-gray-200 dark:border-gray-800 overflow-y-auto p-4 flex flex-col">
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Topic</label>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded text-sm dark:bg-gray-800"
          />
        </div>

        <button
          onClick={addNewWord}
          disabled={isGeneratingWord}
          className="w-full py-2 px-3 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm font-medium mb-4"
        >
          {isGeneratingWord ? "Generating..." : "+ New Word"}
        </button>

        <div className="text-xs text-gray-500 mb-2">
          {words.length} words | {queue.length} in queue
        </div>

        <div className="flex-1 overflow-y-auto space-y-1">
          {words.map((w) => (
            <div
              key={w.word}
              className="p-2 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
              onClick={() => generateSentence(w.word)}
            >
              <div className="font-medium">{w.word}</div>
              <div className="text-xs text-gray-500 truncate">{w.definition}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right area: sentence queue */}
      <div className="flex-1 flex flex-col p-6 overflow-hidden">
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded text-sm">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">
              dismiss
            </button>
          </div>
        )}

        {currentSentence ? (
          <div className="flex-1 flex flex-col justify-center max-w-2xl mx-auto w-full">
            {/* Word info */}
            <div className="mb-6 text-center">
              <span className="text-sm text-gray-500">
                {currentSentence.word} ({activeIndex + 1}/{queue.length})
              </span>
            </div>

            {/* Sentence display */}
            <div
              className="text-2xl md:text-3xl leading-relaxed mb-6 text-center cursor-pointer"
              onClick={() => playTTS(currentSentence.sentence)}
              title="Click to play audio"
            >
              {highlightWord(currentSentence.sentence, currentSentence.word)}
            </div>

            {/* Details view */}
            {showDetails && (
              <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2">
                {currentSentence.reading && (
                  <div className="text-lg text-gray-600 dark:text-gray-400">
                    {currentSentence.reading}
                  </div>
                )}
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {currentSentence.explanation}
                </div>
              </div>
            )}

            {!showDetails && (
              <button
                onClick={() => setShowDetails(true)}
                className="mb-6 text-sm text-gray-500 hover:underline text-center"
              >
                Show reading & explanation (or press →)
              </button>
            )}

            {/* Rating buttons */}
            <div className="flex gap-3 justify-center">
              {[
                { rating: 1, label: "Again", key: "1", color: "bg-red-500 hover:bg-red-600" },
                { rating: 2, label: "Hard", key: "2", color: "bg-orange-500 hover:bg-orange-600" },
                { rating: 3, label: "Good", key: "3", color: "bg-green-500 hover:bg-green-600" },
                { rating: 4, label: "Easy", key: "4", color: "bg-blue-500 hover:bg-blue-600" },
              ].map(({ rating, label, key, color }) => (
                <button
                  key={rating}
                  onClick={() => rateSentence(currentSentence.id, rating)}
                  className={`px-4 py-2 text-white rounded ${color} text-sm font-medium`}
                >
                  {label} <span className="opacity-60 text-xs">({key})</span>
                </button>
              ))}
            </div>

            {/* Hotkey hint */}
            <div className="mt-8 text-center text-xs text-gray-400">
              1-4: rate | ↑↓: navigate | ←→: toggle details | 5: delete word
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              {isGeneratingSentence ? (
                <p>Generating sentence...</p>
              ) : words.length === 0 ? (
                <div>
                  <p className="text-lg mb-2">No words yet</p>
                  <p className="text-sm">Click &quot;+ New Word&quot; to get started</p>
                </div>
              ) : (
                <p>Queue is empty. Click a word to generate a sentence.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function highlightWord(sentence: string, word: string): React.ReactNode {
  if (!word) return sentence;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = sentence.split(new RegExp(`(${escaped})`, "g"));
  return parts.map((part, i) =>
    part === word ? (
      <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
