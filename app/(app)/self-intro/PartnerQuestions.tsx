"use client";

/**
 * The Learning Partner's follow-up questions on the facts step
 * (docs/self-intro-import.md, "Follow-up questions"): one question at a time,
 * only about fields still empty or only "not sure"; the user types an answer
 * or taps a suggestion, or skips. Each turn is one POST to
 * /api/self-intro/followup, which reads the answer into facts (handed up
 * through `onFacts`, to keep, edit or drop like the others) and asks the
 * next question. Nothing is stored: the questions and answers live in this
 * component's state only.
 */
import { useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { IMPORT, type SelfIntroField } from "@/lib/self-intro/import-config";
import { openFields, type FactState } from "@/lib/self-intro/open-fields";

type Asked = { field: SelfIntroField; question: string; answer: string };
type Question = { field: SelfIntroField; text: string; suggestions: string[] };
export type NewFact = { field: SelfIntroField; value: string; certain: boolean };

const muted = "text-[oklch(0.5_0.02_260)] dark:text-[oklch(0.72_0.02_260)]";

export default function PartnerQuestions({
  facts,
  onFacts,
}: {
  facts: (FactState & { value: string })[];
  onFacts: (facts: NewFact[]) => void;
}) {
  const c = useIntlayer("self-intro-import");
  const lp = useIntlayer("learning-partner");
  const { locale } = useLocale();
  const [asked, setAsked] = useState<Asked[]>([]);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "asking" | "done" | "failed">("idle");
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const started = useRef(false);

  const turn = async (list: Asked[]) => {
    setBusy(true);
    setQuestion(null);
    try {
      const r = await fetch("/api/self-intro/followup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          facts: factsRef.current.map(({ field, value, certain, status }) => ({
            field,
            value: value.slice(0, IMPORT.maxFieldChars),
            certain,
            status,
          })),
          asked: list,
          locale,
        }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { facts: NewFact[]; question: Question | null };
      if (j.facts.length) onFacts(j.facts);
      setQuestion(j.question);
      setState(j.question ? "asking" : "done");
    } catch {
      setState("failed");
    } finally {
      setBusy(false);
    }
  };

  // Start once, when there is something to ask about.
  useEffect(() => {
    if (started.current || !openFields(factsRef.current, []).length) return;
    started.current = true;
    void turn([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reply = (text: string) => {
    if (!question || busy) return;
    const list = [
      ...asked,
      {
        field: question.field,
        question: question.text.slice(0, IMPORT.followup.maxQuestionChars),
        answer: text.trim().slice(0, IMPORT.maxFieldChars),
      },
    ];
    setAsked(list);
    setAnswer("");
    void turn(list);
  };

  if (state === "idle") return null;
  return (
    <section
      aria-live="polite"
      className="mb-8 rounded-2xl p-4 bg-[oklch(0.55_0.198_22.3/0.07)] dark:bg-[oklch(0.55_0.198_22.3/0.14)]"
    >
      <p className="text-sm font-semibold mb-2 text-[oklch(0.45_0.176_22.3)] dark:text-[oklch(0.8_0.11_22.3)]">
        {lp.name}
      </p>
      {asked.map((a, i) => (
        <div key={i} className="mb-2 text-sm">
          <p className={muted}>{a.question}</p>
          {a.answer && <p className="text-right">{a.answer}</p>}
        </div>
      ))}
      {busy && <p className={`text-sm ${muted}`}>{c.partnerThinking}</p>}
      {state === "done" && !busy && <p>{c.partnerDone}</p>}
      {state === "failed" && !busy && <p className={muted}>{c.partnerFailed}</p>}
      {question && !busy && (
        <>
          <p className="text-lg mb-3">{question.text}</p>
          {question.suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {question.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => reply(s)}
                  className="px-3 py-1.5 rounded-full text-sm border border-[oklch(0.55_0.198_22.3/0.5)] text-[oklch(0.45_0.176_22.3)] dark:text-[oklch(0.82_0.11_22.3)] hover:bg-[oklch(0.55_0.198_22.3/0.1)]"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (answer.trim()) reply(answer);
            }}
          >
            <input
              value={answer}
              maxLength={IMPORT.maxFieldChars}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={c.answerPlaceholder.value}
              aria-label={question.text}
              className="flex-1 min-w-0 rounded-lg border border-[oklch(0.85_0.01_260)] dark:border-[oklch(0.4_0.02_260)] bg-[oklch(1_0_0)] dark:bg-[oklch(0.24_0.01_260)] px-3 py-2"
            />
            <button
              type="submit"
              disabled={!answer.trim()}
              className="px-4 py-2 rounded-lg font-medium bg-[oklch(0.55_0.198_22.3)] text-[oklch(0.99_0_0)] disabled:opacity-50"
            >
              {c.send}
            </button>
          </form>
          <button
            type="button"
            onClick={() => reply("")}
            className={`mt-2 text-sm underline ${muted}`}
          >
            {c.skipQuestion}
          </button>
        </>
      )}
    </section>
  );
}
