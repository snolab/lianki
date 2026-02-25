"use client";

import { useState } from "react";

type Language = {
  code: string;
  name: string;
  nativeName: string;
};

const LANGUAGES: Language[] = [
  { code: "en-US", name: "English", nativeName: "English" },
  { code: "zh-CN", name: "Chinese (Mandarin)", nativeName: "中文" },
  { code: "ja-JP", name: "Japanese", nativeName: "日本語" },
  { code: "ko-KR", name: "Korean", nativeName: "한국어" },
  { code: "es-ES", name: "Spanish", nativeName: "Español" },
  { code: "fr-FR", name: "French", nativeName: "Français" },
  { code: "de-DE", name: "German", nativeName: "Deutsch" },
  { code: "it-IT", name: "Italian", nativeName: "Italiano" },
  { code: "pt-BR", name: "Portuguese", nativeName: "Português" },
  { code: "ru-RU", name: "Russian", nativeName: "Русский" },
];

type Question = {
  id: string;
  question: string;
  placeholder: string;
  example: string;
};

const QUESTIONS: Question[] = [
  {
    id: "name",
    question: "What is your name?",
    placeholder: "e.g., Zhang Wei",
    example: "My name is Zhang Wei.",
  },
  {
    id: "from",
    question: "Where are you from?",
    placeholder: "e.g., Shanghai, China",
    example: "I am from Shanghai, China.",
  },
  {
    id: "age",
    question: "How old are you?",
    placeholder: "e.g., 25",
    example: "I am 25 years old.",
  },
  {
    id: "occupation",
    question: "What do you do?",
    placeholder: "e.g., software engineer",
    example: "I am a software engineer.",
  },
  {
    id: "hobby",
    question: "What are your hobbies?",
    placeholder: "e.g., reading, hiking",
    example: "I like reading and hiking.",
  },
  {
    id: "languages",
    question: "What languages do you speak?",
    placeholder: "e.g., Chinese, English",
    example: "I speak Chinese and English.",
  },
];

type VoiceSettings = {
  voice: string;
  speed: number;
};

const OPENAI_VOICES = [
  { id: "alloy", name: "Alloy", gender: "neutral" },
  { id: "echo", name: "Echo", gender: "male" },
  { id: "fable", name: "Fable", gender: "neutral" },
  { id: "onyx", name: "Onyx", gender: "male" },
  { id: "nova", name: "Nova", gender: "female" },
  { id: "shimmer", name: "Shimmer", gender: "female" },
];

export default function SelfIntroClient() {
  const [step, setStep] = useState<"select-language" | "interview" | "review">("select-language");
  const [selectedLanguage, setSelectedLanguage] = useState<Language | null>(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [generatedSentences, setGeneratedSentences] = useState<
    Record<string, { text: string; audioUrl: string | null }>
  >({});
  const [editingText, setEditingText] = useState<Record<string, string>>({});
  const [isEditing, setIsEditing] = useState<Record<string, boolean>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    voice: "nova",
    speed: 1.0,
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const currentQuestion = QUESTIONS[currentQuestionIndex];

  const handleLanguageSelect = (language: Language) => {
    setSelectedLanguage(language);
    setStep("interview");
  };

  const generateVoice = async (text: string) => {
    const audioResponse = await fetch("/api/self-intro/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        language: selectedLanguage!.code,
        voice: voiceSettings.voice,
        speed: voiceSettings.speed,
      }),
    });

    const audioBlob = await audioResponse.blob();
    return URL.createObjectURL(audioBlob);
  };

  const handleAnswerSubmit = async () => {
    const answer = answers[currentQuestion.id];
    if (!answer?.trim()) return;

    setIsGenerating(true);
    try {
      // Generate translated sentence using AI
      const response = await fetch("/api/self-intro/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answer,
          questionId: currentQuestion.id,
          targetLanguage: selectedLanguage!.code,
        }),
      });

      const { translatedText } = await response.json();

      // Generate audio
      const audioUrl = await generateVoice(translatedText);

      setGeneratedSentences((prev) => ({
        ...prev,
        [currentQuestion.id]: { text: translatedText, audioUrl },
      }));
    } catch (error) {
      console.error("Error generating:", error);
      alert("Failed to generate. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRegenerateVoice = async (questionId: string) => {
    const text = editingText[questionId] || generatedSentences[questionId]?.text;
    if (!text) return;

    setRegeneratingId(questionId);
    try {
      const audioUrl = await generateVoice(text);

      setGeneratedSentences((prev) => ({
        ...prev,
        [questionId]: { text, audioUrl },
      }));

      setIsEditing((prev) => ({ ...prev, [questionId]: false }));
      setEditingText((prev) => ({ ...prev, [questionId]: "" }));
    } catch (error) {
      console.error("Error regenerating:", error);
      alert("Failed to regenerate voice. Please try again.");
    } finally {
      setRegeneratingId(null);
    }
  };

  const handleNextQuestion = () => {
    if (currentQuestionIndex < QUESTIONS.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      setStep("review");
    }
  };

  const handleSaveToCards = async () => {
    setIsSaving(true);
    try {
      await fetch("/api/self-intro/save-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: selectedLanguage!.code,
          sentences: generatedSentences,
        }),
      });
      alert("Self-introduction cards saved successfully!");
      window.location.href = "/list";
    } catch (error) {
      console.error("Error saving:", error);
      alert("Failed to save cards. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  if (step === "select-language") {
    return (
      <div className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold mb-4">Create Your Self-Introduction</h1>
          <p className="text-lg mb-8">
            Choose the language you want to learn to introduce yourself in:
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => handleLanguageSelect(lang)}
                className="p-6 border-2 border-gray-300 rounded-lg hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900 transition-colors text-left"
              >
                <div className="text-2xl mb-2">{lang.nativeName}</div>
                <div className="text-sm text-gray-600 dark:text-gray-400">{lang.name}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (step === "interview") {
    return (
      <div className="min-h-screen p-8">
        <div className="max-w-2xl mx-auto">
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold">
                Learning: {selectedLanguage!.nativeName} ({selectedLanguage!.name})
              </h2>
              <button
                onClick={() => setStep("select-language")}
                className="text-blue-600 hover:underline"
              >
                Change Language
              </button>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${((currentQuestionIndex + 1) / QUESTIONS.length) * 100}%` }}
              />
            </div>
            <p className="text-sm text-gray-600 mt-2">
              Question {currentQuestionIndex + 1} of {QUESTIONS.length}
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
            <h3 className="text-xl font-semibold mb-4">{currentQuestion.question}</h3>
            <input
              type="text"
              placeholder={currentQuestion.placeholder}
              value={answers[currentQuestion.id] || ""}
              onChange={(e) =>
                setAnswers((prev) => ({ ...prev, [currentQuestion.id]: e.target.value }))
              }
              className="w-full p-3 border border-gray-300 rounded-lg mb-4 dark:bg-gray-700 dark:border-gray-600"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAnswerSubmit();
              }}
            />

            <details className="mb-4">
              <summary className="cursor-pointer text-blue-600 hover:underline mb-2">
                Show example
              </summary>
              <p className="text-gray-600 dark:text-gray-400 italic">{currentQuestion.example}</p>
            </details>

            {generatedSentences[currentQuestion.id] && (
              <div className="mb-4 p-4 bg-green-50 dark:bg-green-900 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold">Generated:</p>
                  {!isEditing[currentQuestion.id] && (
                    <button
                      onClick={() =>
                        setIsEditing((prev) => ({ ...prev, [currentQuestion.id]: true }))
                      }
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Edit
                    </button>
                  )}
                </div>

                {isEditing[currentQuestion.id] ? (
                  <div className="space-y-2">
                    <textarea
                      value={
                        editingText[currentQuestion.id] ??
                        generatedSentences[currentQuestion.id].text
                      }
                      onChange={(e) =>
                        setEditingText((prev) => ({
                          ...prev,
                          [currentQuestion.id]: e.target.value,
                        }))
                      }
                      className="w-full p-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600"
                      rows={3}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRegenerateVoice(currentQuestion.id)}
                        disabled={regeneratingId === currentQuestion.id}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                      >
                        {regeneratingId === currentQuestion.id
                          ? "Regenerating..."
                          : "Regenerate Voice"}
                      </button>
                      <button
                        onClick={() => {
                          setIsEditing((prev) => ({ ...prev, [currentQuestion.id]: false }));
                          setEditingText((prev) => ({ ...prev, [currentQuestion.id]: "" }));
                        }}
                        className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="mb-2">{generatedSentences[currentQuestion.id].text}</p>
                    {generatedSentences[currentQuestion.id].audioUrl && (
                      <div className="space-y-2">
                        <audio
                          controls
                          autoPlay
                          src={generatedSentences[currentQuestion.id].audioUrl!}
                          className="w-full"
                        />
                        <button
                          onClick={() => handleRegenerateVoice(currentQuestion.id)}
                          disabled={regeneratingId === currentQuestion.id}
                          className="text-sm text-blue-600 hover:underline disabled:opacity-50"
                        >
                          {regeneratingId === currentQuestion.id
                            ? "Regenerating..."
                            : "Regenerate Voice"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="mb-4">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-sm text-gray-600 hover:underline"
              >
                {showAdvanced ? "Hide" : "Show"} Advanced Options
              </button>
              {showAdvanced && (
                <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Voice</label>
                    <select
                      value={voiceSettings.voice}
                      onChange={(e) =>
                        setVoiceSettings((prev) => ({ ...prev, voice: e.target.value }))
                      }
                      className="w-full p-2 border border-gray-300 rounded dark:bg-gray-600"
                    >
                      {OPENAI_VOICES.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} ({v.gender})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Speech Rate: {voiceSettings.speed}x
                    </label>
                    <input
                      type="range"
                      min="0.25"
                      max="2.0"
                      step="0.25"
                      value={voiceSettings.speed}
                      onChange={(e) =>
                        setVoiceSettings((prev) => ({ ...prev, speed: parseFloat(e.target.value) }))
                      }
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                      <span>Slow (0.25x)</span>
                      <span>Normal (1.0x)</span>
                      <span>Fast (2.0x)</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-4">
              {currentQuestionIndex > 0 && (
                <button
                  onClick={() => setCurrentQuestionIndex(currentQuestionIndex - 1)}
                  className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                  disabled={isGenerating}
                >
                  Back
                </button>
              )}
              {!generatedSentences[currentQuestion.id] ? (
                <button
                  onClick={handleAnswerSubmit}
                  disabled={!answers[currentQuestion.id]?.trim() || isGenerating}
                  className="flex-1 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isGenerating ? "Generating..." : "Generate"}
                </button>
              ) : (
                <button
                  onClick={handleNextQuestion}
                  className="flex-1 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  {currentQuestionIndex < QUESTIONS.length - 1 ? "Next Question" : "Review All"}
                </button>
              )}
            </div>
          </div>

          {/* Previously Generated Sentences */}
          {Object.keys(generatedSentences).length > 0 && (
            <div className="mt-8">
              <h3 className="text-xl font-semibold mb-4">Your Self-Introduction So Far:</h3>
              <div className="space-y-4">
                {QUESTIONS.filter((q) => generatedSentences[q.id]).map((q) => {
                  const sentence = generatedSentences[q.id];
                  const isCurrentQuestion = q.id === currentQuestion.id;
                  if (isCurrentQuestion) return null; // Don't show current question here

                  return (
                    <div key={q.id} className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">{q.question}</p>
                      {isEditing[q.id] ? (
                        <div className="space-y-2">
                          <textarea
                            value={editingText[q.id] ?? sentence.text}
                            onChange={(e) =>
                              setEditingText((prev) => ({ ...prev, [q.id]: e.target.value }))
                            }
                            className="w-full p-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600"
                            rows={2}
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleRegenerateVoice(q.id)}
                              disabled={regeneratingId === q.id}
                              className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                            >
                              {regeneratingId === q.id ? "Regenerating..." : "Save & Regenerate"}
                            </button>
                            <button
                              onClick={() => {
                                setIsEditing((prev) => ({ ...prev, [q.id]: false }));
                                setEditingText((prev) => ({ ...prev, [q.id]: "" }));
                              }}
                              className="px-3 py-1 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between mb-2">
                            <p className="text-lg flex-1">{sentence.text}</p>
                            <button
                              onClick={() => setIsEditing((prev) => ({ ...prev, [q.id]: true }))}
                              className="text-sm text-blue-600 hover:underline ml-2"
                            >
                              Edit
                            </button>
                          </div>
                          {sentence.audioUrl && (
                            <audio controls src={sentence.audioUrl} className="w-full" />
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step === "review") {
    return (
      <div className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold mb-8">Review Your Self-Introduction</h2>
          <div className="space-y-6 mb-8">
            {QUESTIONS.map((q) => {
              const sentence = generatedSentences[q.id];
              if (!sentence) return null;
              return (
                <div key={q.id} className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-lg">{q.question}</h3>
                    {!isEditing[q.id] && (
                      <button
                        onClick={() => setIsEditing((prev) => ({ ...prev, [q.id]: true }))}
                        className="text-sm text-blue-600 hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <p className="text-gray-600 dark:text-gray-400 mb-4">
                    Your answer: {answers[q.id]}
                  </p>

                  {isEditing[q.id] ? (
                    <div className="space-y-3">
                      <textarea
                        value={editingText[q.id] ?? sentence.text}
                        onChange={(e) =>
                          setEditingText((prev) => ({ ...prev, [q.id]: e.target.value }))
                        }
                        className="w-full p-3 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600 text-lg"
                        rows={3}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleRegenerateVoice(q.id)}
                          disabled={regeneratingId === q.id}
                          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                        >
                          {regeneratingId === q.id ? "Regenerating..." : "Save & Regenerate Voice"}
                        </button>
                        <button
                          onClick={() => {
                            setIsEditing((prev) => ({ ...prev, [q.id]: false }));
                            setEditingText((prev) => ({ ...prev, [q.id]: "" }));
                          }}
                          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-xl mb-4">{sentence.text}</p>
                      {sentence.audioUrl && (
                        <div className="space-y-2">
                          <audio controls src={sentence.audioUrl} className="w-full" />
                          <button
                            onClick={() => handleRegenerateVoice(q.id)}
                            disabled={regeneratingId === q.id}
                            className="text-sm text-blue-600 hover:underline disabled:opacity-50"
                          >
                            {regeneratingId === q.id ? "Regenerating..." : "Regenerate Voice"}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex gap-4">
            <button
              onClick={() => {
                setStep("interview");
                setCurrentQuestionIndex(0);
              }}
              className="px-6 py-3 border border-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Edit Answers
            </button>
            <button
              onClick={handleSaveToCards}
              disabled={isSaving}
              className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {isSaving ? "Saving..." : "Save to Lianki Cards"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
