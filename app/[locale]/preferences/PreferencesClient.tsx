"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import TokenManager from "../list/components/TokenManager";

type FilterType = "domain" | "title" | "url";

interface FilterPattern {
  id: string;
  type: FilterType;
  pattern: string;
  isRegex: boolean;
  enabled: boolean;
  createdAt: string;
}

export default function PreferencesClient() {
  const {
    loading: loadingText,
    heading,
    mobileFilters,
    save,
    errors,
    success,
    examples,
  } = useIntlayer("preferences-page");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [patterns, setPatterns] = useState<FilterPattern[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [newType, setNewType] = useState<FilterType>("domain");
  const [isRegex, setIsRegex] = useState(false);

  useEffect(() => {
    fetchPreferences();
  }, []);

  async function fetchPreferences() {
    try {
      const res = await fetch("/api/preferences");
      if (!res.ok) throw new Error(errors.failedToFetch);
      const data = await res.json();
      setPatterns(data.mobileExcludePatterns || []);
    } catch (error) {
      console.error("Error fetching preferences:", error);
      alert(errors.failedToLoad);
    } finally {
      setLoading(false);
    }
  }

  async function savePreferences() {
    setSaving(true);
    try {
      const res = await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mobileExcludePatterns: patterns,
        }),
      });
      if (!res.ok) throw new Error(errors.failedToSave);
      alert(success.saved);
    } catch (error) {
      console.error("Error saving preferences:", error);
      alert(errors.failedToSave);
    } finally {
      setSaving(false);
    }
  }

  function addPattern() {
    if (!newPattern.trim()) return;

    // Validate regex if enabled
    if (isRegex) {
      try {
        new RegExp(newPattern);
      } catch (e) {
        alert(errors.invalidRegex);
        return;
      }
    }

    const pattern: FilterPattern = {
      id: crypto.randomUUID(),
      type: newType,
      pattern: newPattern.trim(),
      isRegex,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    setPatterns([...patterns, pattern]);
    setNewPattern("");
    setIsRegex(false);
  }

  function removePattern(id: string) {
    setPatterns(patterns.filter((p) => p.id !== id));
  }

  function togglePattern(id: string) {
    setPatterns(patterns.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)));
  }

  function getPatternExamples(type: FilterType, isRegex: boolean): string {
    if (isRegex) {
      return {
        domain: examples.domainRegex,
        title: examples.titleRegex,
        url: examples.urlRegex,
      }[type];
    }
    return {
      domain: examples.domainPlain,
      title: examples.titlePlain,
      url: examples.urlPlain,
    }[type];
  }

  if (loading) {
    return <div className="p-8">{loadingText}</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">{heading}</h1>

      {/* Mobile Exclude Patterns */}
      <section className="mb-10">
        <h2 className="text-2xl font-semibold mb-4 text-white">{mobileFilters.heading}</h2>
        <p className="text-gray-400 mb-4">{mobileFilters.description}</p>

        {/* Current Patterns */}
        <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-6 mb-4">
          <h3 className="text-lg font-medium mb-3 text-gray-200">{mobileFilters.activeFilters}</h3>
          {patterns.length === 0 ? (
            <p className="text-gray-500">{mobileFilters.noFilters}</p>
          ) : (
            <ul className="space-y-2">
              {patterns.map((pattern) => (
                <li
                  key={pattern.id}
                  className={`flex items-center justify-between gap-4 bg-gray-800/50 border rounded px-4 py-3 ${
                    pattern.enabled ? "border-gray-700" : "border-gray-800 opacity-50"
                  }`}
                >
                  <div className="flex items-center gap-3 flex-1">
                    <input
                      type="checkbox"
                      checked={pattern.enabled}
                      onChange={() => togglePattern(pattern.id)}
                      className="w-4 h-4 rounded"
                    />
                    <div className="flex-1">
                      <div className="font-mono text-sm text-gray-200">{pattern.pattern}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        <span
                          className={`inline-block px-2 py-0.5 rounded ${
                            pattern.type === "domain"
                              ? "bg-blue-900/30 text-blue-400"
                              : pattern.type === "title"
                                ? "bg-green-900/30 text-green-400"
                                : "bg-purple-900/30 text-purple-400"
                          }`}
                        >
                          {pattern.type}
                        </span>
                        {pattern.isRegex && (
                          <span className="ml-2 inline-block px-2 py-0.5 rounded bg-orange-900/30 text-orange-400">
                            regex
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => removePattern(pattern.id)}
                    className="text-red-400 hover:text-red-300 transition-colors text-sm shrink-0"
                  >
                    {mobileFilters.remove}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add New Pattern */}
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4 text-gray-200">{mobileFilters.addPattern}</h3>

          {/* Filter Type */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2 text-gray-300">
              {mobileFilters.filterType}
            </label>
            <div className="flex gap-3">
              {(["domain", "title", "url"] as FilterType[]).map((type) => (
                <button
                  key={type}
                  onClick={() => setNewType(type)}
                  className={`px-4 py-2 rounded transition-colors ${
                    newType === type
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                  }`}
                >
                  {mobileFilters[type]}
                </button>
              ))}
            </div>
          </div>

          {/* Pattern Input */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2 text-gray-300">
              {mobileFilters.patternLabel}
            </label>
            <input
              type="text"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPattern();
                }
              }}
              placeholder={String(mobileFilters.patternPlaceholder).replace("{type}", newType)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            />
            <p className="text-xs text-gray-500 mt-2">{getPatternExamples(newType, isRegex)}</p>
          </div>

          {/* Regex Checkbox */}
          <div className="mb-4">
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={isRegex}
                onChange={(e) => setIsRegex(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span>{mobileFilters.useRegex}</span>
            </label>
            <p className="text-xs text-gray-500 mt-1 ml-6">{mobileFilters.regexHelp}</p>
          </div>

          {/* Add Button */}
          <button
            onClick={addPattern}
            disabled={!newPattern.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 px-6 py-2 rounded transition-colors"
          >
            {mobileFilters.addFilter}
          </button>
        </div>

        {/* Help Text */}
        <div className="mt-4 p-4 bg-blue-900/20 border border-blue-800/30 rounded-lg">
          <h4 className="text-sm font-semibold mb-2 text-blue-300">{mobileFilters.howItWorks}</h4>
          <ul className="text-xs text-gray-400 space-y-1">
            <li>{mobileFilters.helpDomain}</li>
            <li>{mobileFilters.helpTitle}</li>
            <li>{mobileFilters.helpUrl}</li>
            <li>{mobileFilters.helpRegex}</li>
            <li>• {mobileFilters.helpDisabled}</li>
          </ul>
        </div>
      </section>

      {/* API Tokens */}
      <TokenManager />

      {/* Save Button */}
      <div className="flex gap-4">
        <button
          onClick={savePreferences}
          disabled={saving}
          className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-8 py-3 rounded font-semibold text-lg"
        >
          {saving ? save.saving : save.saveButton}
        </button>
      </div>
    </div>
  );
}
