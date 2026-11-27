"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import dynamic from "next/dynamic";
import type {
  RoadmapDoc,
  RoadmapGoalDTO as RoadmapGoal,
  RoadmapNode,
  RoadmapNodeProgress,
} from "@/types/roadmap";
import type { RoadmapProgress } from "@/types/roadmap";
import { countLabel, fill } from "@/lib/roadmap/labels";
import { deckHref, matchExamDecks, type ExamDeckMeta } from "@/lib/roadmap/exam-match";
import { loadCatalog } from "@/lib/words/catalog-cache";
import { normalizeSteps } from "@/lib/roadmap/notation";
import { logToggle, setCheck } from "@/lib/roadmap/doc-checklist";
import { measureStep } from "@/lib/roadmap/measure";
import { overallShare, paceVerdict, roadmapEta, utcDay, type PaceState } from "@/lib/roadmap/eta";
import { etaText, verdictText } from "@/lib/roadmap/eta-text";
import { publicCfg } from "@/lib/config-client";
import StepList, { type StepView } from "./StepList";
import PaceIndicator from "./PaceIndicator";
import type { SaveResult } from "./DocEditor";

/** Why making a roadmap failed, as the page words it. */
type GenerateError = "failed" | "limited";

const RoadmapD3 = dynamic(() => import("./RoadmapD3"), { ssr: false });

type Props = {
  locale: string;
  initialGoals: RoadmapGoal[];
};

/** The pace settings until the server's arrive (config roadmap.paceWindowDays / paceMinActiveDays defaults). */
const PACE_FALLBACK = { windowDays: 14, minActiveDays: 3 };

export default function RoadmapClient({ locale, initialGoals }: Props) {
  const text = useIntlayer("roadmap-page");
  const st = useIntlayer("roadmap-steps");
  // Goal editor: open, and its draft (the pace line follows the draft date at once).
  const [editingGoal, setEditingGoal] = useState(false);
  const [draftTopic, setDraftTopic] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [goalError, setGoalError] = useState<"taken" | "failed" | null>(null);
  const [savingGoal, setSavingGoal] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [newStep, setNewStep] = useState("");
  const [goals, setGoals] = useState<RoadmapGoal[]>(initialGoals);
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<RoadmapGoal | null>(null);
  const [progress, setProgress] = useState<RoadmapProgress | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [progressFailed, setProgressFailed] = useState(false);
  const [generateError, setGenerateError] = useState<GenerateError | null>(null);
  // The wish that failed, for Try again (the input may have changed since).
  const failedWish = useRef("");
  // The word-list catalogue, for "this wish names an exam deck" (lib/roadmap/exam-match.ts).
  const [decks, setDecks] = useState<ExamDeckMeta[]>([]);
  const [deckNames, setDeckNames] = useState<Record<string, string>>({});
  useEffect(() => {
    loadCatalog<{ lists?: ExamDeckMeta[] }>("/words/index.json")
      .then((c) => {
        setDecks((c.lists ?? []).filter((d) => d.exam));
        setDeckNames(Object.fromEntries((c.lists ?? []).map((d) => [d.id, d.name])));
      })
      .catch(() => {});
  }, []);
  // Only the latest click may fill the pane: a slow answer for a roadmap the
  // learner has already left must not overwrite the one now shown.
  const requestRef = useRef(0);
  const detailRef = useRef<HTMLDivElement>(null);

  const loadProgress = useCallback(async (goal: RoadmapGoal) => {
    const req = ++requestRef.current;
    // The steps are already here; show them at once and fill the counts in.
    setSelectedGoal(goal);
    setEditingGoal(false);
    setSaveFailed(false);
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

  const generateRoadmap = useCallback(
    async (given?: string) => {
      const wish = (given ?? topic).trim();
      if (!wish) return;
      setGenerating(true);
      setGenerateError(null);
      failedWish.current = wish;
      try {
        const genRes = await fetch("/api/roadmap/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: wish }),
        });
        // 402 (no credits) and 503 (paused) are worded by the page-wide credits notice.
        if (genRes.status === 429) {
          setGenerateError("limited");
          return;
        }
        if (!genRes.ok) throw new Error(`generate ${genRes.status}`);
        const { nodes } = await genRes.json();

        const saveRes = await fetch("/api/roadmap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: wish, nodes }),
        });
        if (!saveRes.ok) throw new Error(`save ${saveRes.status}`);
        const saved: RoadmapGoal = await saveRes.json();

        // Saving the same wish again replaces that roadmap (one per topic).
        setGoals((prev) => [saved, ...prev.filter((g) => String(g._id) !== String(saved._id))]);
        setTopic("");
        await loadProgress(saved);
      } catch (e: unknown) {
        console.error("roadmap generate", e);
        setGenerateError("failed");
      } finally {
        setGenerating(false);
      }
    },
    [topic, loadProgress],
  );

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

  // The goal's steps in notation order (old roadmaps: one stage per step).
  const goalNodes: RoadmapNode[] = useMemo(
    () => normalizeSteps(selectedGoal?.nodes ?? []),
    [selectedGoal],
  );
  const steps: StepView[] = progress?.nodes ?? goalNodes;
  const pct = (rate: number) => Math.round(rate * 100);
  const paceCfg = progress?.pace ?? { ...PACE_FALLBACK, today: utcDay(Date.now()) };
  const settings = { today: paceCfg.today, minActiveDays: paceCfg.minActiveDays };
  const overall = progress ? roadmapEta(progress.nodes, settings) : null;
  const share = progress ? overallShare(progress.nodes) : null;
  // While the editor is open the pace follows the draft date at once.
  const target = editingGoal ? draftDate || null : (selectedGoal?.targetDate ?? null);
  const verdict = overall
    ? paceVerdict(overall, target, settings.today, publicCfg("roadmap.aheadDays"))
    : null;
  const etaStrings = {
    daysOne: st.daysOne.value,
    daysOther: st.daysOther.value,
    etaLine: st.etaLine.value,
    etaFinished: st.etaFinished.value,
    etaTooLittle: st.etaTooLittle.value,
    etaNone: st.etaNone.value,
  };
  const paceStrings = {
    ...etaStrings,
    paceOnPaceDetail: st.paceOnPaceDetail.value,
    paceAheadDetail: st.paceAheadDetail.value,
    paceBehindDetail: st.paceBehindDetail.value,
    paceNoDataDetail: st.paceNoDataDetail.value,
    paceNoTarget: st.paceNoTarget.value,
    needWords: st.needWords.value,
    needItems: st.needItems.value,
  };
  const paceLabels: Record<PaceState, string> = {
    "on-pace": st.paceOnPace.value,
    ahead: st.paceAhead.value,
    behind: st.paceBehind.value,
    "no-data": st.paceNoData.value,
  };

  /** Save a change to the shown roadmap; the list and the pane take the saved goal. */
  const patchGoal = async (patch: {
    topic?: string;
    targetDate?: string | null;
    nodes?: RoadmapNode[];
  }): Promise<{ ok: true; goal: RoadmapGoal } | { ok: false; status: number }> => {
    if (!selectedGoal) return { ok: false, status: 0 };
    try {
      const r = await fetch(`/api/roadmap/${selectedGoal._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) return { ok: false, status: r.status };
      const saved = (await r.json()) as RoadmapGoal;
      const g = { ...saved, _id: String(saved._id ?? selectedGoal._id) };
      setGoals((prev) => prev.map((x) => (String(x._id) === g._id ? g : x)));
      setSelectedGoal(g);
      return { ok: true, goal: g };
    } catch {
      return { ok: false, status: 0 };
    }
  };

  /** The pane's steps after a doc change, measured again here (no reload). */
  const withDoc = (id: string, doc: RoadmapDoc) => {
    const nodes = goalNodes.map((n) => (n.id === id ? { ...n, doc } : n));
    setProgress((p) =>
      p
        ? {
            ...p,
            goal: { ...p.goal, nodes },
            nodes: p.nodes.map(
              (n): RoadmapNodeProgress =>
                n.id === id
                  ? { ...n, doc, measure: measureStep({ ...n, doc }, { ...paceCfg, decks: {} }) }
                  : n,
            ),
          }
        : p,
    );
    return nodes;
  };

  const toggleCheck = async (id: string, index: number, checked: boolean) => {
    const node = goalNodes.find((n) => n.id === id);
    if (!node) return;
    const before = node.doc ?? {};
    const doc = {
      ...before,
      markdown: setCheck(before.markdown ?? "", index, checked),
      doneLog: logToggle(before.doneLog, checked, new Date()),
    };
    const nodes = withDoc(id, doc);
    setSelectedGoal((g) => (g ? { ...g, nodes } : g));
    const r = await patchGoal({ nodes });
    setSaveFailed(!r.ok);
    if (!r.ok) {
      withDoc(id, before);
      setSelectedGoal((g) => (g ? { ...g, nodes: goalNodes } : g));
    }
  };

  const saveDoc = async (id: string, doc: RoadmapDoc): Promise<SaveResult> => {
    const nodes = goalNodes.map((n) => (n.id === id ? { ...n, doc } : n));
    const r = await patchGoal({ nodes });
    if (!r.ok) return r.status === 413 ? "too-long" : "failed";
    withDoc(id, doc);
    return "ok";
  };

  const addDocStep = async () => {
    const title = newStep.trim().slice(0, 100);
    if (!title || goalNodes.length >= 20) return;
    const last = goalNodes.reduce((m, n) => Math.max(m, n.stage ?? 0), 0);
    const node: RoadmapNode = {
      id: `doc_${Date.now().toString(36)}`,
      title,
      description: "",
      keywords: [],
      order: goalNodes.length,
      stage: last + 1,
      kind: "doc",
      doc: { markdown: "" },
    };
    const r = await patchGoal({ nodes: [...goalNodes, node] });
    setSaveFailed(!r.ok);
    if (r.ok) {
      setNewStep("");
      await loadProgress(r.goal);
    }
  };

  const openGoalEditor = () => {
    if (!selectedGoal) return;
    setDraftTopic(selectedGoal.topic);
    setDraftDate(selectedGoal.targetDate ?? "");
    setGoalError(null);
    setEditingGoal(true);
  };

  const saveGoalEdit = async () => {
    const topicNow = draftTopic.trim();
    if (!topicNow || !selectedGoal) return;
    setSavingGoal(true);
    const r = await patchGoal({
      ...(topicNow !== selectedGoal.topic ? { topic: topicNow } : {}),
      targetDate: draftDate || null,
    });
    setSavingGoal(false);
    if (r.ok) {
      setEditingGoal(false);
      setProgress((p) => (p ? { ...p, goal: { ...p.goal, ...r.goal, nodes: p.goal.nodes } } : p));
    } else setGoalError(r.status === 409 ? "taken" : "failed");
  };
  const examDecks = useMemo(
    () => (selectedGoal ? matchExamDecks(selectedGoal.topic, decks) : []),
    [selectedGoal, decks],
  );

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

      {generateError && (
        <div
          role="alert"
          data-generate-error={generateError}
          className="flex items-center gap-3 mb-4 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg text-red-700 dark:text-red-300 text-sm"
        >
          <span className="flex-1">
            {generateError === "limited" ? text.generateLimited : text.generateFailed}
          </span>
          {generateError === "failed" && (
            <button
              type="button"
              disabled={generating}
              onClick={() => void generateRoadmap(failedWish.current)}
              className="shrink-0 rounded-md border border-current px-2 py-1 text-xs font-medium disabled:opacity-50"
            >
              {text.generateRetry}
            </button>
          )}
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
              <div className="flex items-start gap-2 mb-2">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 min-w-0 flex-1 break-words">
                  {selectedGoal.topic}
                </h2>
                <button
                  type="button"
                  onClick={() => (editingGoal ? setEditingGoal(false) : openGoalEditor())}
                  aria-expanded={editingGoal}
                  title={st.editGoal.value}
                  data-edit-goal
                  className="-me-2 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  <Icon name="pencilSimple" label={st.editGoal.value} />
                </button>
              </div>

              {editingGoal && (
                <form
                  data-goal-editor
                  className="mb-4 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveGoalEdit();
                  }}
                >
                  <label className="block text-xs text-gray-500 dark:text-gray-400">
                    {st.goalLabel}
                    <input
                      value={draftTopic}
                      onChange={(e) => setDraftTopic(e.target.value)}
                      maxLength={500}
                      className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 md:text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                    />
                  </label>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="block text-xs text-gray-500 dark:text-gray-400">
                      {st.targetDateLabel}
                      <input
                        type="date"
                        value={draftDate}
                        onChange={(e) => setDraftDate(e.target.value)}
                        data-target-date
                        className="mt-1 block min-h-10 rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 md:text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                      />
                    </label>
                    {draftDate && (
                      <button
                        type="button"
                        onClick={() => setDraftDate("")}
                        className="min-h-10 rounded-lg px-3 text-sm text-gray-700 dark:text-gray-300"
                      >
                        {st.clearDate}
                      </button>
                    )}
                  </div>
                  {goalError && (
                    <p
                      role="alert"
                      className="flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300"
                    >
                      <Icon name="warning" />
                      {goalError === "taken" ? st.topicTaken : st.saveFailed}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={savingGoal || !draftTopic.trim()}
                      className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50"
                    >
                      {savingGoal ? st.saving : st.save}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingGoal(false)}
                      className="min-h-10 rounded-lg px-3 text-sm text-gray-700 dark:text-gray-300"
                    >
                      {st.cancel}
                    </button>
                  </div>
                </form>
              )}

              {overall && (
                <div data-roadmap-eta={overall.kind} className="mb-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {st.etaHeading}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span
                      className={
                        overall.kind === "too-little" || overall.kind === "na"
                          ? "text-sm text-gray-700 dark:text-gray-300"
                          : "text-xl font-semibold text-gray-900 dark:text-gray-100"
                      }
                    >
                      {overall.kind === "too-little"
                        ? st.roadmapTooLittle
                        : overall.kind === "na"
                          ? st.roadmapNoEstimate
                          : etaText(overall, locale, settings.today, etaStrings)}
                    </span>
                    {share != null && (
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {fill(text.percentComplete.value, { pct: pct(share) })}
                      </span>
                    )}
                  </div>
                  {verdict && (
                    <PaceIndicator
                      verdict={verdict}
                      labels={paceLabels}
                      label={st.paceLabel.value}
                      detail={verdictText(verdict, locale, settings.today, paceStrings)}
                    />
                  )}
                </div>
              )}

              {saveFailed && (
                <p
                  role="alert"
                  className="mb-3 flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300"
                >
                  <Icon name="warning" />
                  {st.saveFailed}
                </p>
              )}

              {examDecks.length > 0 && (
                <div data-exam-decks className="flex flex-wrap gap-2 mb-4">
                  {examDecks.map((d) => (
                    <a
                      key={d.id}
                      href={deckHref(d.id)}
                      data-exam-deck={d.id}
                      className="inline-flex items-center rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 px-3 py-1.5 text-sm text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50"
                    >
                      {fill(text.examDeckLink.value, { deck: d.name })}
                    </a>
                  ))}
                </div>
              )}

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

              <StepList
                locale={locale}
                steps={steps}
                today={settings.today}
                minActiveDays={settings.minActiveDays}
                docMaxChars={publicCfg("roadmap.docMaxChars")}
                deckNames={deckNames}
                noCards={text.noCards.value}
                cardsCountTitle={text.cardsCountTitle.value}
                stepDone={text.stepDone.value}
                onToggle={(id, i, c) => void toggleCheck(id, i, c)}
                onSaveDoc={saveDoc}
              />

              {progress && goalNodes.length < 20 && (
                <form
                  className="mt-4 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addDocStep();
                  }}
                >
                  <input
                    value={newStep}
                    onChange={(e) => setNewStep(e.target.value)}
                    maxLength={100}
                    placeholder={st.newStepTitle.value}
                    aria-label={st.newStepTitle.value}
                    className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder:text-gray-400 md:text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                  <button
                    type="submit"
                    disabled={!newStep.trim()}
                    title={st.addDocStep.value}
                    className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-lg border border-blue-600 px-3 text-sm font-medium text-blue-600 disabled:opacity-50 dark:border-blue-300 dark:text-blue-300"
                  >
                    <Icon name="plus" />
                    <span className="hidden sm:inline">{st.addDocStep}</span>
                    <span className="sm:hidden">{st.add}</span>
                  </button>
                </form>
              )}
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
