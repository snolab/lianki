"use client";

import { useState, useCallback, useRef } from "react";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import dynamic from "next/dynamic";
import type { RoadmapGoalDTO as RoadmapGoal, RoadmapNode } from "@/types/roadmap";
import type { RoadmapProgress } from "@/types/roadmap";
import { countLabel, fill } from "@/lib/roadmap/labels";

const RoadmapD3 = dynamic(() => import("./RoadmapD3"), { ssr: false });

type Props = {
  locale: string;
  initialGoals: RoadmapGoal[];
};

/** A step as the detail pane shows it: the counts are absent until progress arrives. */
type StepView = RoadmapNode & { totalCards?: number; matureCards?: number; maturityRate?: number };

export default function RoadmapClient({ locale, initialGoals }: Props) {
  const text = useIntlayer("roadmap-page");
  const [goals, setGoals] = useState<RoadmapGoal[]>(initialGoals);
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<RoadmapGoal | null>(null);
  const [progress, setProgress] = useState<RoadmapProgress | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [progressFailed, setProgressFailed] = useState(false);
  const [generateFailed, setGenerateFailed] = useState(false);
  // Only the latest click may fill the pane: a slow answer for a roadmap the
  // learner has already left must not overwrite the one now shown.
  const requestRef = useRef(0);
  const detailRef = useRef<HTMLDivElement>(null);

  const loadProgress = useCallback(async (goal: RoadmapGoal) => {
    const req = ++requestRef.current;
    // The steps are already here; show them at once and fill the counts in.
    setSelectedGoal(goal);
    setLoadingProgress(true);
    setProgressFailed(false);
    setProgress(null);
    // Phones stack the list above the pane: bring the pane into view.
    if (window.matchMedia?.("(max-width: 767px)").matches) {
      requestAnimationFrame(() =>
        detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
    try {
      const res = await fetch(`/api/roadmap/${goal._id}/progress`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RoadmapProgress = await res.json();
      if (req === requestRef.current) setProgress(data);
    } catch {
      if (req === requestRef.current) setProgressFailed(true);
    } finally {
      if (req === requestRef.current) setLoadingProgress(false);
    }
  }, []);

  const generateRoadmap = useCallback(async () => {
    const wish = topic.trim();
    if (!wish) return;
    setGenerating(true);
    setGenerateFailed(false);
    try {
      const genRes = await fetch("/api/roadmap/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: wish }),
      });
      if (!genRes.ok) throw new Error(await genRes.text());
      const { nodes } = await genRes.json();

      const saveRes = await fetch("/api/roadmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: wish, nodes }),
      });
      if (!saveRes.ok) throw new Error(await saveRes.text());
      const saved: RoadmapGoal = await saveRes.json();

      // Saving the same wish again replaces that roadmap (one per topic).
      setGoals((prev) => [saved, ...prev.filter((g) => String(g._id) !== String(saved._id))]);
      setTopic("");
      await loadProgress(saved);
    } catch (e: unknown) {
      console.error("roadmap generate", e);
      setGenerateFailed(true);
    } finally {
      setGenerating(false);
    }
  }, [topic, loadProgress]);

  const deleteGoal = useCallback(
    async (goal: RoadmapGoal) => {
      await fetch(`/api/roadmap?id=${goal._id}`, { method: "DELETE" });
      setGoals((prev) => prev.filter((g) => String(g._id) !== String(goal._id)));
      if (String(selectedGoal?._id) === String(goal._id)) {
        requestRef.current++;
        setSelectedGoal(null);
        setProgress(null);
        setLoadingProgress(false);
        setProgressFailed(false);
      }
    },
    [selectedGoal],
  );

  const steps: StepView[] = (progress?.nodes ?? selectedGoal?.nodes ?? [])
    .slice()
    .sort((a, b) => a.order - b.order);
  const pct = (rate: number) => Math.round(rate * 100);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">{text.heading}</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">{text.intro}</p>

      {/* Input */}
      <form
        className="flex gap-2 mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          void generateRoadmap();
        }}
      >
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={text.wishPlaceholder.value}
          aria-label={text.wishLabel.value}
          className="flex-1 min-w-0 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 px-4 py-2 text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={generating}
          maxLength={500}
        />
        <button
          type="submit"
          disabled={generating || !topic.trim()}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0 md:min-w-[120px]"
        >
          {generating ? text.generating : text.generate}
        </button>
      </form>

      {generateFailed && (
        <div
          role="alert"
          className="mb-4 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg text-red-700 dark:text-red-300 text-sm"
        >
          {text.generateFailed}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-6">
        {/* Goal list: above the pane on phones, at its left on wide screens */}
        {goals.length > 0 && (
          <aside className="md:w-56 md:shrink-0">
            <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              {text.yourRoadmaps}
            </h2>
            <ul className="space-y-1">
              {goals.map((goal) => {
                const selected = String(selectedGoal?._id) === String(goal._id);
                return (
                  <li key={String(goal._id)}>
                    <div
                      className={`flex items-start px-3 py-2 rounded-lg text-sm transition-colors group ${
                        selected
                          ? "bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-medium"
                          : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => loadProgress(goal)}
                        aria-current={selected ? "true" : undefined}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="truncate">{goal.topic}</div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          {countLabel(
                            locale,
                            goal.nodes.length,
                            text.stepsOne.value,
                            text.stepsOther.value,
                          )}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteGoal(goal)}
                        className="ml-1 p-1 -m-1 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 text-gray-400 hover:text-red-500 text-xs shrink-0"
                        title={text.deleteRoadmap.value}
                      >
                        <Icon name="x" label={text.deleteRoadmap.value} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </aside>
        )}

        {/* Detail pane */}
        <div ref={detailRef} className="flex-1 min-w-0 scroll-mt-20">
          {selectedGoal && (
            <div data-roadmap-detail data-loaded={progress ? "1" : "0"}>
              <div className="flex items-baseline justify-between gap-3 mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 min-w-0 break-words">
                  {selectedGoal.topic}
                </h2>
                {progress && (
                  <span className="text-sm text-gray-500 dark:text-gray-400 shrink-0">
                    {fill(text.percentComplete.value, { pct: pct(progress.overallMaturityRate) })}
                  </span>
                )}
              </div>

              {loadingProgress && (
                <div
                  role="status"
                  className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm mb-4"
                >
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  {text.loadingProgress}
                </div>
              )}

              {progressFailed && (
                <div
                  role="alert"
                  className="flex items-center gap-3 mb-4 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg text-red-700 dark:text-red-300 text-sm"
                >
                  <span className="flex-1">{text.progressFailed}</span>
                  <button
                    type="button"
                    onClick={() => loadProgress(selectedGoal)}
                    className="shrink-0 rounded-md border border-current px-2 py-1 text-xs font-medium"
                  >
                    {text.retry}
                  </button>
                </div>
              )}

              {/* The map, wide screens only: on a phone it repeats the list below at a size
                  that does not fit, so the list alone carries the same numbers there. */}
              {progress && (
                <div className="hidden md:block">
                  <RoadmapD3
                    nodes={progress.nodes}
                    overallMaturityRate={progress.overallMaturityRate}
                    labels={{
                      cardsCount: text.cardsCount.value,
                      noCards: text.noCards.value,
                      overallProgress: text.overallProgress.value,
                    }}
                  />
                </div>
              )}

              {/* Step list */}
              <ol className="mt-6 space-y-2">
                {steps.map((node) => {
                  const known = node.maturityRate != null;
                  const rate = node.maturityRate ?? 0;
                  return (
                    <li
                      key={node.id}
                      data-step
                      className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-800"
                    >
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                          rate >= 1
                            ? "bg-green-600 text-white"
                            : rate > 0
                              ? "bg-yellow-400 text-gray-900"
                              : "bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-300"
                        }`}
                      >
                        {rate >= 1 ? (
                          <Icon name="check" label={text.stepDone.value} />
                        ) : (
                          node.order + 1
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {node.title}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 md:truncate">
                          {node.description}
                        </div>
                      </div>
                      <div
                        className="shrink-0 text-right min-w-[3.5rem]"
                        title={text.cardsCountTitle.value}
                      >
                        {known ? (
                          <>
                            <div className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                              {pct(rate)}%
                            </div>
                            <div className="text-xs text-gray-400 dark:text-gray-500">
                              {node.totalCards
                                ? `${node.matureCards}/${node.totalCards}`
                                : text.noCards}
                            </div>
                          </>
                        ) : (
                          <div className="text-sm text-gray-300 dark:text-gray-600" aria-hidden>
                            …
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {!selectedGoal && goals.length === 0 && (
            <div className="text-center py-16 text-gray-400 dark:text-gray-500">
              <Icon name="mapTrifold" className="text-4xl mb-3" />
              <div className="text-sm">{text.emptyFirst}</div>
            </div>
          )}

          {!selectedGoal && goals.length > 0 && (
            <div className="text-center py-8 md:py-16 text-gray-400 dark:text-gray-500">
              <div className="text-sm">{text.selectHint}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
