"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type { RoadmapGoal } from "@/types/roadmap";
import type { RoadmapProgress } from "@/types/roadmap";

const RoadmapD3 = dynamic(() => import("./RoadmapD3"), { ssr: false });

type Props = {
  locale: string;
  initialGoals: RoadmapGoal[];
};

export default function RoadmapClient({ locale, initialGoals }: Props) {
  const [goals, setGoals] = useState<RoadmapGoal[]>(initialGoals);
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<RoadmapGoal | null>(null);
  const [progress, setProgress] = useState<RoadmapProgress | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateRoadmap = useCallback(async () => {
    if (!topic.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const genRes = await fetch("/api/roadmap/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim() }),
      });
      if (!genRes.ok) throw new Error(await genRes.text());
      const { nodes } = await genRes.json();

      const saveRes = await fetch("/api/roadmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim(), nodes }),
      });
      if (!saveRes.ok) throw new Error(await saveRes.text());
      const saved: RoadmapGoal = await saveRes.json();

      setGoals((prev) => [saved, ...prev]);
      setTopic("");
      await loadProgress(saved);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [topic]);

  const loadProgress = useCallback(async (goal: RoadmapGoal) => {
    setSelectedGoal(goal);
    setLoadingProgress(true);
    setProgress(null);
    try {
      const res = await fetch(`/api/roadmap/${goal._id}/progress`);
      if (!res.ok) throw new Error(await res.text());
      setProgress(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingProgress(false);
    }
  }, []);

  const deleteGoal = useCallback(
    async (goal: RoadmapGoal) => {
      await fetch(`/api/roadmap?id=${goal._id}`, { method: "DELETE" });
      setGoals((prev) => prev.filter((g) => String(g._id) !== String(goal._id)));
      if (String(selectedGoal?._id) === String(goal._id)) {
        setSelectedGoal(null);
        setProgress(null);
      }
    },
    [selectedGoal],
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">AI Learning Roadmap</h1>
      <p className="text-gray-500 text-sm mb-6">
        Enter a topic and AI will generate a structured learning roadmap. Progress is tracked from
        your study cards.
      </p>

      {/* Input */}
      <div className="flex gap-2 mb-6">
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && generateRoadmap()}
          placeholder="e.g. Japanese N3, React hooks, Python basics..."
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={generating}
        />
        <button
          onClick={generateRoadmap}
          disabled={generating || !topic.trim()}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed min-w-[120px]"
        >
          {generating ? "Generating..." : "Generate"}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-6">
        {/* Sidebar: goal list */}
        {goals.length > 0 && (
          <aside className="w-56 shrink-0">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Your Roadmaps
            </h2>
            <ul className="space-y-1">
              {goals.map((goal) => (
                <li key={String(goal._id)}>
                  <div
                    className={`flex items-start px-3 py-2 rounded-lg text-sm transition-colors group ${
                      String(selectedGoal?._id) === String(goal._id)
                        ? "bg-blue-50 text-blue-700 font-medium"
                        : "hover:bg-gray-100 text-gray-700"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => loadProgress(goal)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="truncate">{goal.topic}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{goal.nodes.length} steps</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteGoal(goal)}
                      className="ml-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs shrink-0"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        )}

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {loadingProgress && (
            <div className="flex items-center gap-2 text-gray-500 text-sm py-12 justify-center">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
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
              Loading progress...
            </div>
          )}

          {progress && !loadingProgress && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">{progress.goal.topic}</h2>
                <span className="text-sm text-gray-500">
                  {Math.round(progress.overallMaturityRate * 100)}% complete
                </span>
              </div>

              <RoadmapD3
                nodes={progress.nodes}
                overallMaturityRate={progress.overallMaturityRate}
              />

              {/* Node detail list */}
              <div className="mt-6 space-y-2">
                {progress.nodes
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((node) => (
                    <div
                      key={node.id}
                      className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 border border-gray-100"
                    >
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                          node.maturityRate >= 1
                            ? "bg-green-500 text-white"
                            : node.maturityRate > 0
                              ? "bg-yellow-400 text-white"
                              : "bg-gray-200 text-gray-500"
                        }`}
                      >
                        {node.maturityRate >= 1 ? "✓" : node.order + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900">{node.title}</div>
                        <div className="text-xs text-gray-500 truncate">{node.description}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold text-gray-700">
                          {Math.round(node.maturityRate * 100)}%
                        </div>
                        <div className="text-xs text-gray-400">
                          {node.matureCards}/{node.totalCards}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {!selectedGoal && !loadingProgress && goals.length === 0 && (
            <div className="text-center py-16 text-gray-400">
              <div className="text-4xl mb-3">🗺️</div>
              <div className="text-sm">Enter a topic above to generate your first roadmap</div>
            </div>
          )}

          {!selectedGoal && !loadingProgress && goals.length > 0 && (
            <div className="text-center py-16 text-gray-400">
              <div className="text-sm">Select a roadmap from the left to view progress</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
