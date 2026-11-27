"use client";

/**
 * A roadmap's steps in the ordering notation (lib/roadmap/notation.ts):
 * stage by stage, the lanes of one stage (2A, 2B, 2C) drawn together with a
 * seal-red rule at their start. Each step shows what it is measured in (page
 * cards, a word list, a doc's checklist), the estimate at the learner's own
 * pace first, and its percentage small beside it.
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import type { RoadmapDoc, RoadmapNode, RoadmapNodeProgress } from "@/types/roadmap";
import { stages, stepLabel } from "@/lib/roadmap/notation";
import { stepEta } from "@/lib/roadmap/eta";
import { etaText } from "@/lib/roadmap/eta-text";
import { fill } from "@/lib/roadmap/labels";
import { deckHref } from "@/lib/roadmap/exam-match";
import DocEditor, { type SaveResult } from "./DocEditor";

const DocMarkdown = dynamic(() => import("./DocMarkdown"), { ssr: false });

export type StepView = RoadmapNode & Partial<Omit<RoadmapNodeProgress, keyof RoadmapNode>>;

type Props = {
  locale: string;
  steps: StepView[];
  today: string;
  minActiveDays: number;
  docMaxChars: number;
  deckNames: Record<string, string>;
  /** Page-card strings of the roadmap-page dictionary. */
  noCards: string;
  cardsCountTitle: string;
  stepDone: string;
  onToggle: (nodeId: string, index: number, checked: boolean) => void;
  onSaveDoc: (nodeId: string, doc: RoadmapDoc) => Promise<SaveResult>;
};

export default function StepList(p: Props) {
  const s = useIntlayer("roadmap-steps");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const groups = stages(p.steps);
  const parallel = groups.some((g) => g.length > 1);
  const pace = { today: p.today, minActiveDays: p.minActiveDays };
  const etaStrings = {
    daysOne: s.daysOne.value,
    daysOther: s.daysOther.value,
    etaLine: s.etaLine.value,
    etaFinished: s.etaFinished.value,
    etaTooLittle: s.etaTooLittle.value,
    etaNone: s.etaNone.value,
  };
  const editorStrings = {
    docPlaceholder: s.docPlaceholder.value,
    docMarkdownLabel: s.docMarkdownLabel.value,
    docReaderLabel: s.docReaderLabel.value,
    docUrlLabel: s.docUrlLabel.value,
    docAddImage: s.docAddImage.value,
    imageUploading: s.imageUploading.value,
    imageFull: s.imageFull.value,
    imageFullLink: s.imageFullLink.value,
    imageTooBig: s.imageTooBig.value,
    imageFailed: s.imageFailed.value,
    docTooLong: s.docTooLong.value,
    saveFailed: s.saveFailed.value,
    save: s.save.value,
    saving: s.saving.value,
    cancel: s.cancel.value,
  };

  const step = (node: StepView) => {
    const m = node.measure;
    const share = m && m.total ? Math.min(1, m.done / m.total) : null;
    const done = !!m && !!m.total && m.done >= m.total;
    const eta = m ? stepEta(m, pace) : null;
    const label = stepLabel(node);
    const isDoc = node.kind === "doc";
    const shown = !!open[node.id] || editing === node.id;
    return (
      <li
        key={node.id}
        data-step={label}
        data-kind={node.kind ?? "keywords"}
        className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900"
      >
        <div className="flex items-start gap-3">
          <div
            aria-label={fill(s.stepLabelAria.value, { label })}
            role="img"
            className={`flex h-9 min-w-9 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-bold ${
              done
                ? "bg-green-600 text-white"
                : share
                  ? "bg-primary text-on-primary"
                  : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-200"
            }`}
          >
            {done ? <Icon name="check" label={p.stepDone} /> : label}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{node.title}</div>
            {node.description && (
              <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                {node.description}
              </div>
            )}
            {eta && (
              <div
                data-step-eta={eta.kind}
                className="mt-1 text-sm text-gray-800 dark:text-gray-200"
              >
                {etaText(eta, p.locale, p.today, etaStrings)}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              {node.kind === "deck" && node.deck && (
                <>
                  <a
                    href={deckHref(node.deck.id)}
                    data-step-deck={node.deck.id}
                    className="inline-flex min-h-8 items-center gap-1 font-medium text-blue-600 dark:text-blue-300"
                  >
                    <Icon name="cards" />
                    {s.deckStudy} · {p.deckNames[node.deck.id] ?? node.deck.id}
                  </a>
                  {m?.total != null && (
                    <span>{fill(s.wordsCount.value, { done: m.done, total: m.total })}</span>
                  )}
                </>
              )}
              {isDoc && (
                <>
                  <span data-step-checklist>
                    {m?.total
                      ? fill(s.checklistCount.value, { done: m.done, total: m.total })
                      : s.checklistNone}
                  </span>
                  <button
                    type="button"
                    aria-expanded={shown}
                    onClick={() => setOpen((o) => ({ ...o, [node.id]: !shown }))}
                    className="inline-flex min-h-8 items-center gap-1 font-medium text-blue-600 dark:text-blue-300"
                  >
                    <Icon name="bookOpen" />
                    {shown ? s.docHide : s.docShow}
                  </button>
                  {node.doc?.readerId && (
                    <a
                      href={`/reader/${encodeURIComponent(node.doc.readerId)}`}
                      className="inline-flex min-h-8 items-center font-medium text-blue-600 dark:text-blue-300"
                    >
                      {s.docReaderLink}
                    </a>
                  )}
                  {node.doc?.url && (
                    <a
                      href={node.doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-8 items-center gap-1 font-medium text-blue-600 dark:text-blue-300"
                    >
                      <Icon name="link" />
                      {s.docUrlLink}
                    </a>
                  )}
                </>
              )}
              {(node.kind ?? "keywords") === "keywords" && node.totalCards != null && (
                <span title={p.cardsCountTitle}>
                  {node.totalCards ? `${node.matureCards}/${node.totalCards}` : p.noCards}
                </span>
              )}
            </div>
          </div>
          {share != null && (
            <div className="shrink-0 pt-0.5 text-xs text-gray-400 dark:text-gray-500">
              {Math.round(share * 100)}%
            </div>
          )}
        </div>
        {isDoc && shown && (
          <div className="mt-2 ps-12">
            {editing === node.id ? (
              <DocEditor
                doc={node.doc}
                maxChars={p.docMaxChars}
                strings={editorStrings}
                onCancel={() => setEditing(null)}
                onSave={async (doc) => {
                  const r = await p.onSaveDoc(node.id, doc);
                  if (r === "ok") setEditing(null);
                  return r;
                }}
              />
            ) : (
              <>
                {node.doc?.markdown && (
                  <DocMarkdown
                    markdown={node.doc.markdown}
                    onToggle={(i, c) => p.onToggle(node.id, i, c)}
                  />
                )}
                <button
                  type="button"
                  onClick={() => setEditing(node.id)}
                  className="mt-1 inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-blue-600 dark:text-blue-300"
                >
                  <Icon name="pencilSimple" />
                  {s.edit}
                </button>
              </>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      <ol data-steps className="mt-6 space-y-2">
        {groups.map((g) =>
          g.length > 1 ? (
            <li
              key={`stage-${g[0].stage}`}
              data-stage={g[0].stage}
              className="border-s-2 border-blue-600/50 ps-2 dark:border-blue-300/50"
            >
              <ol className="space-y-2">{g.map(step)}</ol>
            </li>
          ) : (
            step(g[0])
          ),
        )}
      </ol>
      {parallel && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{s.parallelNote}</p>
      )}
    </>
  );
}
