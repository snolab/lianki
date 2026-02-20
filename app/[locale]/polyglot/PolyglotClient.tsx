"use client";

import { useState } from "react";
import { useIntlayer } from "next-intlayer";

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
  { code: "ar-SA", name: "Arabic", nativeName: "العربية" },
  { code: "hi-IN", name: "Hindi", nativeName: "हिन्दी" },
];

type Question = {
  id: string;
  text: string;
  category: string;
};

const DEFAULT_QUESTIONS: Question[] = [
  // Basic Introduction
  { id: "q1", text: "What is your name?", category: "Basic Introduction" },
  { id: "q2", text: "Where are you from?", category: "Basic Introduction" },
  { id: "q3", text: "How old are you?", category: "Basic Introduction" },
  { id: "q4", text: "What do you do for work?", category: "Basic Introduction" },
  { id: "q5", text: "What are your hobbies?", category: "Basic Introduction" },

  // Daily Life
  { id: "q6", text: "What time do you wake up?", category: "Daily Life" },
  { id: "q7", text: "What do you usually eat for breakfast?", category: "Daily Life" },
  { id: "q8", text: "How do you get to work?", category: "Daily Life" },
  { id: "q9", text: "What do you do in your free time?", category: "Daily Life" },
  { id: "q10", text: "What time do you go to bed?", category: "Daily Life" },

  // Family & Relationships
  { id: "q11", text: "Do you have any siblings?", category: "Family & Relationships" },
  { id: "q12", text: "Are you married?", category: "Family & Relationships" },
  { id: "q13", text: "Do you have any children?", category: "Family & Relationships" },
  { id: "q14", text: "Where does your family live?", category: "Family & Relationships" },
  { id: "q15", text: "How often do you see your family?", category: "Family & Relationships" },

  // Interests & Preferences
  { id: "q16", text: "What kind of music do you like?", category: "Interests & Preferences" },
  { id: "q17", text: "What is your favorite food?", category: "Interests & Preferences" },
  { id: "q18", text: "Do you like sports?", category: "Interests & Preferences" },
  {
    id: "q19",
    text: "What is your favorite movie or TV show?",
    category: "Interests & Preferences",
  },
  { id: "q20", text: "Do you like traveling?", category: "Interests & Preferences" },

  // Language Learning
  { id: "q21", text: "What languages do you speak?", category: "Language Learning" },
  { id: "q22", text: "Why are you learning this language?", category: "Language Learning" },
  { id: "q23", text: "How long have you been studying?", category: "Language Learning" },
  { id: "q24", text: "What is the hardest part about learning?", category: "Language Learning" },
  { id: "q25", text: "Do you practice with native speakers?", category: "Language Learning" },

  // Future & Goals
  { id: "q26", text: "What are your plans for the future?", category: "Future & Goals" },
  { id: "q27", text: "Where do you want to travel next?", category: "Future & Goals" },
  { id: "q28", text: "What is your dream job?", category: "Future & Goals" },
  { id: "q29", text: "What do you want to achieve this year?", category: "Future & Goals" },
  { id: "q30", text: "What is your biggest goal in life?", category: "Future & Goals" },
];

type TranslatedContent = {
  question: string;
  answer: string;
  questionAudioUrl: string | null;
  answerAudioUrl: string | null;
};

type CellData = Record<string, TranslatedContent>; // langCode -> content

export default function PolyglotClient() {
  const {
    heading,
    description,
    selectMotherTongue,
    selectTargetLanguages,
    continueToQuestions,
    motherTongueLabel,
    generateAll: generateAllText,
    changeLanguages: changeLanguagesText,
    addQuestionPlaceholder,
    addQuestion: addQuestionText,
    questionYourAnswer,
    answerInLanguage,
    generating: generatingText,
    generateRow: generateRowText,
    questionLabel,
    answerLabel,
    playQuestion: playQuestionText,
    playAnswer: playAnswerText,
    regenerate: regenerateText,
    generate: generateText,
    answerFirst: answerFirstText,
    cellsGenerated,
    saving: savingText,
    saveToCards: saveToCardsText,
    errors,
    categories,
  } = useIntlayer("polyglot-page");

  const [isSaving, setIsSaving] = useState(false);
  const [motherTongue, setMotherTongue] = useState<Language | null>(null);
  const [selectedLanguages, setSelectedLanguages] = useState<Language[]>([]);
  const [questions, setQuestions] = useState<Question[]>(DEFAULT_QUESTIONS);
  const [answers, setAnswers] = useState<Record<string, string>>({}); // questionId -> answer in mother tongue
  const [matrix, setMatrix] = useState<Record<string, CellData>>({}); // questionId -> CellData
  const [generatingCell, setGeneratingCell] = useState<string | null>(null);
  const [customQuestion, setCustomQuestion] = useState("");
  const [showLanguageSelector, setShowLanguageSelector] = useState(true);

  const toggleLanguage = (lang: Language) => {
    if (selectedLanguages.find((l) => l.code === lang.code)) {
      setSelectedLanguages(selectedLanguages.filter((l) => l.code !== lang.code));
    } else {
      setSelectedLanguages([...selectedLanguages, lang]);
    }
  };

  const getCategoryTranslation = (category: string): string => {
    const categoryMap: Record<string, string> = {
      "Basic Introduction": categories.basicIntroduction,
      "Daily Life": categories.dailyLife,
      "Family & Relationships": categories.familyRelationships,
      "Interests & Preferences": categories.interestsPreferences,
      "Language Learning": categories.languageLearning,
      "Future & Goals": categories.futureGoals,
      "Custom": categories.custom,
    };
    return categoryMap[category] || category;
  };

  const addCustomQuestion = () => {
    if (!customQuestion.trim()) return;
    const newQuestion: Question = {
      id: `custom-${Date.now()}`,
      text: customQuestion,
      category: "Custom",
    };
    setQuestions([...questions, newQuestion]);
    setCustomQuestion("");
  };

  const generateCell = async (questionId: string, langCode: string) => {
    const question = questions.find((q) => q.id === questionId);
    const answer = answers[questionId];
    if (!question || !answer?.trim()) return;

    const cellKey = `${questionId}-${langCode}`;
    setGeneratingCell(cellKey);

    try {
      // Translate question and answer
      const translationResponse = await fetch("/api/polyglot/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: question.text,
          answer,
          targetLanguage: langCode,
          sourceLanguage: motherTongue?.code || "en-US",
        }),
      });

      const { translatedQuestion, translatedAnswer } = await translationResponse.json();

      // Generate TTS for question
      const questionAudioResponse = await fetch("/api/polyglot/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: translatedQuestion,
          language: langCode,
        }),
      });
      const questionBlob = await questionAudioResponse.blob();
      const questionAudioUrl = URL.createObjectURL(questionBlob);

      // Generate TTS for answer
      const answerAudioResponse = await fetch("/api/polyglot/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: translatedAnswer,
          language: langCode,
        }),
      });
      const answerBlob = await answerAudioResponse.blob();
      const answerAudioUrl = URL.createObjectURL(answerBlob);

      // Update matrix
      setMatrix((prev) => ({
        ...prev,
        [questionId]: {
          ...(prev[questionId] || {}),
          [langCode]: {
            question: translatedQuestion,
            answer: translatedAnswer,
            questionAudioUrl,
            answerAudioUrl,
          },
        },
      }));
    } catch (error) {
      console.error("Error generating cell:", error);
      alert(errors.failedToGenerate);
    } finally {
      setGeneratingCell(null);
    }
  };

  const generateRow = async (questionId: string) => {
    const question = questions.find((q) => q.id === questionId);
    const answer = answers[questionId];
    if (!question || !answer?.trim()) return;

    // Mark row as generating
    const rowKey = `row-${questionId}`;
    setGeneratingCell(rowKey);

    try {
      // Generate all translations in parallel
      const cellPromises = selectedLanguages.map(async (lang) => {
        try {
          // Translate question and answer
          const translationResponse = await fetch("/api/polyglot/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question: question.text,
              answer,
              targetLanguage: lang.code,
              sourceLanguage: motherTongue?.code || "en-US",
            }),
          });

          const { translatedQuestion, translatedAnswer } = await translationResponse.json();

          // Generate TTS for question
          const questionAudioResponse = await fetch("/api/polyglot/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: translatedQuestion,
              language: lang.code,
            }),
          });
          const questionBlob = await questionAudioResponse.blob();
          const questionAudioUrl = URL.createObjectURL(questionBlob);

          // Generate TTS for answer
          const answerAudioResponse = await fetch("/api/polyglot/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: translatedAnswer,
              language: lang.code,
            }),
          });
          const answerBlob = await answerAudioResponse.blob();
          const answerAudioUrl = URL.createObjectURL(answerBlob);

          return {
            langCode: lang.code,
            data: {
              question: translatedQuestion,
              answer: translatedAnswer,
              questionAudioUrl,
              answerAudioUrl,
            },
          };
        } catch (error) {
          console.error(`Error generating cell for ${lang.code}:`, error);
          return null;
        }
      });

      // Wait for all cells to be generated
      const results = await Promise.all(cellPromises);

      // Update matrix with all new cells in a single state update
      setMatrix((prev) => {
        const newRow: CellData = { ...prev[questionId] };
        results.forEach((result) => {
          if (result) {
            newRow[result.langCode] = result.data;
          }
        });
        return {
          ...prev,
          [questionId]: newRow,
        };
      });
    } catch (error) {
      console.error("Error generating row:", error);
      alert(errors.failedToGenerateRow);
    } finally {
      setGeneratingCell(null);
    }
  };

  const generateAll = async () => {
    for (const question of questions) {
      if (answers[question.id]?.trim()) {
        await generateRow(question.id);
      }
    }
  };

  const saveToCards = async () => {
    setIsSaving(true);
    try {
      const response = await fetch("/api/polyglot/save-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matrix,
          questions,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        if (response.status === 401) {
          alert(errors.signInRequired);
          window.location.href = "/api/auth/signin";
          return;
        }
        throw new Error(error.error || errors.failedToSave);
      }

      const result = await response.json();
      alert(result.message);
      window.location.href = "/list";
    } catch (error) {
      console.error("Error saving:", error);
      alert(errors.failedToSave);
    } finally {
      setIsSaving(false);
    }
  };

  if (showLanguageSelector) {
    return (
      <div className="min-h-screen p-8">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl font-bold mb-4">{heading}</h1>
          <p className="text-lg mb-8">
            {description}
          </p>

          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{selectMotherTongue}</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => setMotherTongue(lang)}
                  className={`p-3 border-2 rounded-lg transition-colors ${
                    motherTongue?.code === lang.code
                      ? "border-blue-600 bg-blue-50 dark:bg-blue-900"
                      : "border-gray-300 hover:border-blue-400"
                  }`}
                >
                  <div className="font-semibold">{lang.nativeName}</div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">{lang.name}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{selectTargetLanguages}</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {LANGUAGES.filter((l) => l.code !== motherTongue?.code).map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => toggleLanguage(lang)}
                  className={`p-3 border-2 rounded-lg transition-colors ${
                    selectedLanguages.find((l) => l.code === lang.code)
                      ? "border-green-600 bg-green-50 dark:bg-green-900"
                      : "border-gray-300 hover:border-green-400"
                  }`}
                >
                  <div className="font-semibold">{lang.nativeName}</div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">{lang.name}</div>
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => setShowLanguageSelector(false)}
            disabled={!motherTongue || selectedLanguages.length === 0}
            className="w-full py-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-lg font-semibold"
          >
            {continueToQuestions.replace("{count}", selectedLanguages.length.toString())}
          </button>
        </div>
      </div>
    );
  }

  const groupedQuestions = questions.reduce(
    (acc, q) => {
      if (!acc[q.category]) acc[q.category] = [];
      acc[q.category].push(q);
      return acc;
    },
    {} as Record<string, Question[]>,
  );

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-full mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">{heading}</h1>
            <p className="text-gray-600 dark:text-gray-400">
              {motherTongueLabel
                .replace("{lang}", motherTongue?.nativeName || "")
                .replace("{langs}", selectedLanguages.map((l) => l.nativeName).join(", "))}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={generateAll}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              {generateAllText}
            </button>
            <button
              onClick={() => setShowLanguageSelector(true)}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {changeLanguagesText}
            </button>
          </div>
        </div>

        {/* Add Custom Question */}
        <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder={addQuestionPlaceholder}
              value={customQuestion}
              onChange={(e) => setCustomQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustomQuestion()}
              className="flex-1 p-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600"
            />
            <button
              onClick={addCustomQuestion}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              {addQuestionText}
            </button>
          </div>
        </div>

        {/* Matrix */}
        <div className="overflow-x-auto">
          {Object.entries(groupedQuestions).map(([category, categoryQuestions]) => (
            <div key={category} className="mb-8">
              <h2 className="text-xl font-bold mb-3 sticky left-0 bg-white dark:bg-gray-900 py-2">
                {getCategoryTranslation(category)}
              </h2>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="border border-gray-300 dark:border-gray-700 p-2 bg-gray-100 dark:bg-gray-800 sticky left-0 z-10 min-w-[300px]">
                      {questionYourAnswer}
                    </th>
                    {selectedLanguages.map((lang) => (
                      <th
                        key={lang.code}
                        className="border border-gray-300 dark:border-gray-700 p-2 bg-gray-100 dark:bg-gray-800 min-w-[250px]"
                      >
                        {lang.nativeName}
                        <br />
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          {lang.name}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {categoryQuestions.map((question) => {
                    const rowKey = `row-${question.id}`;
                    const isRowGenerating = generatingCell === rowKey;

                    return (
                      <tr key={question.id}>
                        <td className="border border-gray-300 dark:border-gray-700 p-3 bg-white dark:bg-gray-900 sticky left-0 z-10">
                          <div className="font-semibold mb-2">{question.text}</div>
                          <input
                            type="text"
                            placeholder={answerInLanguage.replace("{lang}", motherTongue?.nativeName || "")}
                            value={answers[question.id] || ""}
                            onChange={(e) =>
                              setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))
                            }
                            className="w-full p-2 border border-gray-300 rounded dark:bg-gray-800 dark:border-gray-600 text-sm"
                          />
                          {answers[question.id]?.trim() && (
                            <button
                              onClick={() => generateRow(question.id)}
                              disabled={isRowGenerating}
                              className="mt-2 text-sm text-blue-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {isRowGenerating ? generatingText : generateRowText}
                            </button>
                          )}
                        </td>
                        {selectedLanguages.map((lang) => {
                          const cellData = matrix[question.id]?.[lang.code];
                          const cellKey = `${question.id}-${lang.code}`;
                          const rowKey = `row-${question.id}`;
                          const isGenerating =
                            generatingCell === cellKey || generatingCell === rowKey;

                          return (
                            <td
                              key={lang.code}
                              className="border border-gray-300 dark:border-gray-700 p-3"
                            >
                              {isGenerating ? (
                                <div className="text-center text-gray-500">{generatingText}</div>
                              ) : cellData ? (
                                <div className="space-y-2">
                                  <div className="flex items-start gap-2">
                                    <div className="flex-1">
                                      <div className="text-xs text-gray-500 mb-1">{questionLabel}</div>
                                      <div className="text-sm">{cellData.question}</div>
                                    </div>
                                    {cellData.questionAudioUrl && (
                                      <button
                                        onClick={() => {
                                          const audio = new Audio(cellData.questionAudioUrl!);
                                          audio.play();
                                        }}
                                        className="px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 rounded text-xs hover:bg-blue-200 dark:hover:bg-blue-800"
                                      >
                                        {playQuestionText}
                                      </button>
                                    )}
                                  </div>
                                  <div className="flex items-start gap-2">
                                    <div className="flex-1">
                                      <div className="text-xs text-gray-500 mb-1">{answerLabel}</div>
                                      <div className="text-sm font-semibold">{cellData.answer}</div>
                                    </div>
                                    {cellData.answerAudioUrl && (
                                      <button
                                        onClick={() => {
                                          const audio = new Audio(cellData.answerAudioUrl!);
                                          audio.play();
                                        }}
                                        className="px-2 py-1 bg-green-100 dark:bg-green-900 text-green-600 dark:text-green-300 rounded text-xs hover:bg-green-200 dark:hover:bg-green-800"
                                      >
                                        {playAnswerText}
                                      </button>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => generateCell(question.id, lang.code)}
                                    className="text-xs text-gray-500 hover:underline"
                                  >
                                    {regenerateText}
                                  </button>
                                </div>
                              ) : answers[question.id]?.trim() ? (
                                <button
                                  onClick={() => generateCell(question.id, lang.code)}
                                  className="w-full py-2 text-sm bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                                >
                                  {generateText}
                                </button>
                              ) : (
                                <div className="text-center text-gray-400 text-sm">
                                  {answerFirstText}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* Save Button */}
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-white dark:bg-gray-900 border-t border-gray-300 dark:border-gray-700 shadow-lg">
          <div className="max-w-7xl mx-auto flex items-center gap-4">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              {cellsGenerated.replace("{count}", Object.values(matrix).reduce((sum, row) => sum + Object.keys(row).length, 0).toString())}
            </div>
            <button
              onClick={saveToCards}
              disabled={isSaving || Object.keys(matrix).length === 0}
              className="flex-1 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? savingText : saveToCardsText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
