"use client";

import { asReviewOrder, DEFAULT_REVIEW_ORDER, type ReviewOrder } from "@lianki/core";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import TokenManager from "./TokenManager";
import { PaperSkinPicker } from "@/app/components/PaperSkinPicker";
import { TextSizeControls } from "@/app/components/TextSizeControls";
import { ByokSettings } from "@/app/components/ByokSettings";
import { Icon } from "@/app/components/icons";
import { TEXT_AREAS, textSizeStore } from "@/lib/text-size";
import { useTextSizes } from "@/lib/use-text-size";
import { TitleRulesSettings } from "@/app/components/TitleRulesSettings";
import { ExternalLinkSettings } from "@/app/components/ExternalLinkSettings";
import { AppBadgeSettings } from "@/app/components/AppBadgeSettings";
import { MailSettings } from "@/app/components/MailSettings";
import { LanguageSettings } from "@/app/components/LanguageSettings";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import { readOfferOn, writeOfferOn } from "@/lib/read/polish-offer";
import { readNotesOn, writeNotesOn } from "@/lib/read/translator-notes";
import {
  REVIEW_FILTERS_EVENT,
  REVIEW_FILTERS_KEY,
  deviceFilters,
  isMobileAgent,
  type FilterPattern,
} from "@/lib/review-filters";

type FilterType = FilterPattern["type"];

/** A section heading with its reset button (only when there is something to reset). */
/** The reader's offer to tidy a raw transcript: on until he says otherwise. */
function ReaderSettings() {
  const t = useIntlayer("read-polish");
  const [on, setOn] = useState(true);
  const [notes, setNotes] = useState(true);
  useEffect(() => {
    const read = () => {
      setOn(readOfferOn());
      setNotes(readNotesOn());
    };
    read();
    window.addEventListener(PREF_APPLIED_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return (
    <section className="mb-10 max-w-md" data-section="reader">
      <h2 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-white">{t.prefHeading}</h2>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          data-testid="pref-polish-offer"
          onChange={(e) => {
            setOn(e.target.checked);
            writeOfferOn(e.target.checked);
          }}
          className="w-4 h-4 rounded"
        />
        <span>{t.prefOffer}</span>
      </label>
      <p className="text-xs text-gray-500 mt-2 ml-6">{t.prefHelp}</p>
      <label className="flex items-center gap-2 cursor-pointer mt-4">
        <input
          type="checkbox"
          checked={notes}
          data-testid="pref-translator-notes"
          onChange={(e) => {
            setNotes(e.target.checked);
            writeNotesOn(e.target.checked);
          }}
          className="w-4 h-4 rounded"
        />
        <span>{t.prefNotes}</span>
      </label>
      <p className="text-xs text-gray-500 mt-2 ml-6">{t.prefNotesHelp}</p>
    </section>
  );
}

function SectionHeading({
  children,
  label,
  canReset,
  onReset,
}: {
  children: React.ReactNode;
  label: string;
  canReset: boolean;
  onReset: () => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">{children}</h2>
      <button
        type="button"
        onClick={onReset}
        disabled={!canReset}
        aria-label={label}
        title={label}
        data-section-reset
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full opacity-70 hover:bg-[oklch(0.5_0_0/0.12)] hover:opacity-100 disabled:opacity-25 disabled:hover:bg-transparent"
      >
        <Icon name="reset" className="h-5 w-5" />
      </button>
    </div>
  );
}

/** What Save would send, to compare with what the server has. */
const snapshot = (patterns: FilterPattern[], reviewOrder: ReviewOrder, watchTracking: boolean) =>
  JSON.stringify({ patterns, reviewOrder, watchTracking });

export default function PreferencesClient({
  showKeySync = false,
  appBadge = false,
}: {
  showKeySync?: boolean;
  /** `pwa.app-badge` is on: the Notifications section (docs/app-badge.md). */
  appBadge?: boolean;
}) {
  const {
    loading: loadingText,
    heading,
    mobileFilters,
    save,
    errors,
    success,
    examples,
    reviewOrder: reviewOrderUi,
    resetSection,
    paperHeading,
  } = useIntlayer("preferences-page");
  const textSize = useIntlayer("text-size");
  const textSizes = useTextSizes();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [patterns, setPatterns] = useState<FilterPattern[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [newType, setNewType] = useState<FilterType>("domain");
  const [isRegex, setIsRegex] = useState(false);
  const [reviewOrder, setReviewOrder] = useState<ReviewOrder>(DEFAULT_REVIEW_ORDER);
  const [watchTracking, setWatchTracking] = useState(true);
  const [saved, setSaved] = useState("");
  const current = snapshot(patterns, reviewOrder, watchTracking);
  const dirty = !loading && current !== saved;

  useEffect(() => {
    fetchPreferences();
  }, []);

  async function fetchPreferences() {
    try {
      const res = await fetch("/api/preferences");
      if (!res.ok) throw new Error(errors.failedToFetch.value);
      const data = await res.json();
      const loaded = deviceFilters(
        localStorage.getItem(REVIEW_FILTERS_KEY),
        isMobileAgent(navigator.userAgent),
        data.mobileExcludePatterns,
      );
      const order = asReviewOrder(data.reviewOrder);
      // Only an explicit false is off, so a server that predates the setting
      // keeps recording rather than appearing to have it disabled.
      const watch = data.watchTracking !== false;
      setPatterns(loaded);
      setReviewOrder(order);
      setWatchTracking(watch);
      setSaved(snapshot(loaded, order, watch));
    } catch (error) {
      console.error("Error fetching preferences:", error);
      alert(errors.failedToLoad.value);
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
          reviewOrder,
          watchTracking,
        }),
      });
      if (!res.ok) throw new Error(errors.failedToSave.value);
      localStorage.setItem(REVIEW_FILTERS_KEY, JSON.stringify(patterns));
      window.dispatchEvent(new Event(REVIEW_FILTERS_EVENT));
      setSaved(current);
      alert(success.saved.value);
    } catch (error) {
      console.error("Error saving preferences:", error);
      alert(errors.failedToSave.value);
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
        alert(errors.invalidRegex.value);
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
        domain: examples.domainRegex.value,
        title: examples.titleRegex.value,
        url: examples.urlRegex.value,
      }[type];
    }
    return {
      domain: examples.domainPlain.value,
      title: examples.titlePlain.value,
      url: examples.urlPlain.value,
    }[type];
  }

  if (loading) {
    return <div className="p-8">{loadingText}</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">{heading}</h1>

      {/* Language — follows the account (lib/account-locale.ts) */}
      <LanguageSettings />

      {/* Paper skin — this device only, kept in localStorage */}
      <section className="mb-10">
        <h2 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-white">
          {paperHeading}
        </h2>
        <PaperSkinPicker />
      </section>

      {/* Text size — follows the account (lib/text-size.ts) */}
      <section className="mb-10 max-w-md" data-section="text-size">
        <SectionHeading
          label={resetSection.value}
          canReset={TEXT_AREAS.some((a) => textSizes[a] !== 1)}
          onReset={() => textSizeStore.setState({ ui: 1, chat: 1, cards: 1, read: 1 })}
        >
          {textSize.heading}
        </SectionHeading>
        <TextSizeControls />
      </section>

      {/* Notifications: the app-icon badge — follows the account (docs/app-badge.md) */}
      {appBadge && <AppBadgeSettings />}

      {/* Your own AI — the key on this device only (docs/byok.md) */}
      <ByokSettings showKeySync={showKeySync} />

      {/* Page titles — follows the account (docs/title-clean.md) */}
      <TitleRulesSettings />

      {/* Email: which mails the account gets — follows the account (lib/mail-templates/kinds.ts) */}
      <MailSettings />

      {/* Links to other sites — follows the account (lib/external-link.ts) */}
      <ExternalLinkSettings />

      {/* Reader — follows the account (lib/read/polish-offer.ts) */}
      <ReaderSettings />

      {/* Next-card order */}
      <section className="mb-10">
        <SectionHeading
          label={resetSection.value}
          canReset={reviewOrder !== DEFAULT_REVIEW_ORDER}
          onReset={() => setReviewOrder(DEFAULT_REVIEW_ORDER)}
        >
          {reviewOrderUi.heading}
        </SectionHeading>
        <p className="text-gray-400 mb-4">{reviewOrderUi.description}</p>
        <div className="space-y-2">
          {(["newest", "oldest"] as const).map((opt) => (
            <label
              key={opt}
              className="flex items-start gap-3 p-3 rounded-lg bg-white/5 cursor-pointer hover:bg-white/10"
            >
              <input
                type="radio"
                name="reviewOrder"
                className="mt-1"
                checked={reviewOrder === opt}
                onChange={() => setReviewOrder(opt)}
              />
              <span>
                <span className="block font-medium">
                  {reviewOrderUi[opt].label}
                  {opt === DEFAULT_REVIEW_ORDER && <> {reviewOrderUi.defaultMark}</>}
                </span>
                <span className="block text-sm text-gray-400">{reviewOrderUi[opt].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* Watch tracking */}
      <section className="mb-10">
        <SectionHeading
          label={resetSection.value}
          canReset={!watchTracking}
          onReset={() => setWatchTracking(true)}
        >
          Watch time
        </SectionHeading>
        <p className="text-gray-400 mb-4">
          Lianki can measure how long you actually watch or listen to media on a page, to fill your
          streaks and the activity heatmap. Time is counted only while something is playing, audible
          and on screen — never from visiting a page.
        </p>
        <label className="flex items-start gap-3 p-3 rounded-lg bg-white/5 cursor-pointer hover:bg-white/10">
          <input
            type="checkbox"
            id="watchTracking"
            className="mt-1"
            checked={watchTracking}
            onChange={(e) => setWatchTracking(e.target.checked)}
          />
          <span>
            <span className="block font-medium">Record watch time</span>
            <span className="block text-sm text-gray-400">
              Turn this off and nothing about your playback leaves the page. Existing statistics are
              kept; they simply stop growing.
            </span>
          </span>
        </label>
      </section>

      {/* Mobile Exclude Patterns */}
      <section className="mb-10">
        <SectionHeading
          label={resetSection.value}
          canReset={patterns.length > 0}
          onReset={() => setPatterns([])}
        >
          {mobileFilters.heading}
        </SectionHeading>
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
              placeholder={mobileFilters.patternPlaceholder.value.replace("{type}", newType)}
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

      {/* Save: floats above the bottom island, lit while there is something to save */}
      <div
        className="sticky z-30 flex justify-end pt-4"
        style={{
          bottom: "calc(max(env(safe-area-inset-bottom), var(--lk-bottom-reserve, 0px)) + 0.5rem)",
        }}
      >
        <button
          onClick={savePreferences}
          disabled={saving || !dirty}
          data-dirty-save={dirty || undefined}
          className={`rounded-full px-8 py-3 text-lg font-semibold transition-colors ${
            dirty
              ? "bg-[oklch(0.55_0.15_150)] text-[oklch(0.99_0_0)] shadow-lg ring-2 ring-[oklch(0.75_0.15_150)] hover:bg-[oklch(0.5_0.15_150)]"
              : "lk-glass opacity-70"
          }`}
        >
          {saving ? save.saving : save.saveButton}
        </button>
      </div>
    </div>
  );
}
