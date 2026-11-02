/**
 * ASK cards: the agent asks, the owner taps (docs/dev-debug-widget.md, "Ask
 * cards"). A question (or a batch of them, like a list of decisions) with
 * options as pills; the first option may be marked recommended. The page
 * sends only which options were tapped; the HUB stamps the answer (who,
 * which page, when, source "tap") and passes it on, so a tap stays a real
 * human gesture: a controller can never send an answer.
 *
 * Pure: parsing (the agent's ask, the page's answer) and the card's state.
 */

export type AskOption = { id: string; label: string; recommended?: boolean };
export type AskQuestion = { id: string; question: string; options: AskOption[]; multi?: boolean };
export type Ask = { askId: string; questions: AskQuestion[]; expiresAt?: number };
/** Chosen option ids, per question id. */
export type AskChoices = Record<string, string[]>;
/** Stamped by the hub: never taken from a page or an agent as is. */
export type AskAnswer = {
  choices: AskChoices;
  source: "tap";
  /** "owner", or the friend's thread (user id). */
  thread: string;
  /** The page it was tapped on (its label: path, PWA, device). */
  label: string;
  at: number;
};

export const ASK_MAX_QUESTIONS = 20;
export const ASK_MAX_OPTIONS = 8;
export const ASK_MAX_QUESTION = 500;
export const ASK_MAX_LABEL = 120;
/** At most this long until it expires (the agent may ask for less). */
export const ASK_MAX_TTL_MS = 7 * 24 * 3600_000;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

function parseOptions(v: unknown): AskOption[] | string {
  if (!Array.isArray(v) || v.length < 1) return "an ask needs at least one option";
  if (v.length > ASK_MAX_OPTIONS) return `at most ${ASK_MAX_OPTIONS} options`;
  const out: AskOption[] = [];
  for (const [i, o] of v.entries()) {
    const r = (typeof o === "string" ? { label: o } : o) as Record<string, unknown> | null;
    const label = text(r?.label, ASK_MAX_LABEL);
    if (!label) return `option ${i + 1} needs a label`;
    const id = typeof r?.id === "string" && ID.test(r.id) ? r.id : `o${i + 1}`;
    if (out.some((x) => x.id === id)) return `option ids must differ (${id})`;
    out.push({ id, label, ...(r?.recommended === true ? { recommended: true } : {}) });
  }
  return out;
}

/**
 * The agent's ask, checked: either one question ({question, options,
 * multi?}) or a batch ({questions: [...]}); `askId` (made up when absent),
 * `expiresAt` capped at ASK_MAX_TTL_MS from `now`.
 */
export function parseAsk(
  m: Record<string, unknown>,
  now: number,
  newId: () => string,
): { ok: true; ask: Ask } | { ok: false; error: string } {
  const raw = Array.isArray(m.questions)
    ? m.questions
    : [{ id: "q1", question: m.question, options: m.options, multi: m.multi }];
  if (raw.length < 1) return { ok: false, error: "an ask needs a question" };
  if (raw.length > ASK_MAX_QUESTIONS)
    return { ok: false, error: `at most ${ASK_MAX_QUESTIONS} questions in one ask` };
  const questions: AskQuestion[] = [];
  for (const [i, q] of raw.entries()) {
    const r = q as Record<string, unknown> | null;
    const question = text(r?.question, ASK_MAX_QUESTION);
    if (!question) return { ok: false, error: `question ${i + 1} needs text` };
    const options = parseOptions(r?.options);
    if (typeof options === "string") return { ok: false, error: `question ${i + 1}: ${options}` };
    const id = typeof r?.id === "string" && ID.test(r.id) ? r.id : `q${i + 1}`;
    if (questions.some((x) => x.id === id)) return { ok: false, error: `question ids must differ (${id})` };
    questions.push({ id, question, options, ...(r?.multi === true ? { multi: true } : {}) });
  }
  const askId = typeof m.askId === "string" && ID.test(m.askId) ? m.askId : newId();
  const exp = typeof m.expiresAt === "number" && Number.isFinite(m.expiresAt) ? m.expiresAt : undefined;
  const expiresAt = exp === undefined ? undefined : Math.min(exp, now + ASK_MAX_TTL_MS);
  if (expiresAt !== undefined && expiresAt <= now) return { ok: false, error: "expiresAt is already past" };
  return { ok: true, ask: { askId, questions, ...(expiresAt ? { expiresAt } : {}) } };
}

/** A one-line text for the ask (what pages without cards, and the history, show). */
export function askText(a: Ask): string {
  const q = a.questions;
  const first = `${q[0]!.question} — ${q[0]!.options.map((o) => o.label).join(" / ")}`;
  return q.length > 1 ? `${first} (+${q.length - 1} more)` : first;
}

/**
 * A page's tap, checked against the ask: every question answered, with ids
 * it offers, one each unless `multi`. Null: not a valid answer.
 */
export function checkChoices(a: Ask, raw: unknown): AskChoices | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: AskChoices = {};
  for (const q of a.questions) {
    const v = r[q.id];
    const ids = Array.isArray(v) ? v : typeof v === "string" ? [v] : null;
    if (!ids || ids.length < 1) return null;
    if (!q.multi && ids.length > 1) return null;
    const uniq = [...new Set(ids)];
    if (!uniq.every((id) => typeof id === "string" && q.options.some((o) => o.id === id))) return null;
    out[q.id] = uniq as string[];
  }
  return out;
}

/** The card's state now. */
export function askState(
  m: { ask?: Ask; answer?: AskAnswer },
  now: number,
): "open" | "answered" | "expired" {
  if (m.answer) return "answered";
  if (m.ask?.expiresAt !== undefined && now >= m.ask.expiresAt) return "expired";
  return "open";
}
