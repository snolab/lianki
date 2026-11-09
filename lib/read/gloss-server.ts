// The I/O of a book word's meaning (the rules: lib/read/gloss.ts): the decks
// read from the Worker's assets once per isolate, the shared word_gloss rows,
// and the model for what neither has.
import type { D1Like } from "@/lib/d1/types";
import { PARTNER_AI_MODEL, PARTNER_AI_REASONING } from "@/lib/partner-ai-config";
import type { D1WithBatch } from "@/lib/payments/credits-store";
import { metered, type Metered } from "@/lib/payments/metered";
import { textHoldUsd, textUsd, type Feature } from "@/lib/payments/prices";
import { routeLimit } from "@/lib/security/route-guard";
import { isWorkersAiConfigured, workersAiOpenAI } from "@/lib/workers-ai";
import type { BookCtx, RangeWord } from "./book-word-list";
import { glossMessages, headOf, lookupGloss, parseGlosses, type GlossEntry } from "./gloss";
import { readPublicText } from "./lemma-server";
import { phraseTokens } from "./select-meaning";
import { langMatches, termKeys } from "./words";

type Index = { lists: { lang: string; file: string }[] };
type Catalog = { entries: GlossEntry[] };

const decks = new Map<string, Promise<Map<string, GlossEntry>>>();

/** The decks' words of a language by lookup key, first deck first (as lib/read/dict.ts on the device). */
export function deckGlosses(lang: string): Promise<Map<string, GlossEntry>> {
  let p = decks.get(lang);
  if (!p) {
    p = (async () => {
      const json = async <T>(path: string) => {
        const t = await readPublicText(path);
        return t ? (JSON.parse(t) as T) : null;
      };
      const index = await json<Index>("/words/index.json");
      const files = (index?.lists ?? []).filter((l) => langMatches(l.lang, lang));
      const cats = await Promise.all(files.map((l) => json<Catalog>(`/words/${l.file}`)));
      const out = new Map<string, GlossEntry>();
      for (const c of cats)
        for (const e of c?.entries ?? [])
          if (e.back)
            for (const k of termKeys(e.term, e.reading, lang)) if (!out.has(k)) out.set(k, e);
      return out;
    })();
    p.catch(() => decks.delete(lang));
    decks.set(lang, p);
  }
  return p;
}

/** Generated glosses of these headwords (D1 word_gloss). */
async function cachedGlosses(db: D1Like, lang: string, terms: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < terms.length; i += 90) {
    const chunk = terms.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT term, back FROM word_gloss WHERE lang = ? AND term IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(lang, ...chunk)
      .all<{ term: string; back: string }>();
    for (const r of results) out.set(r.term, r.back);
  }
  return out;
}

/**
 * Who pays a model call: the user, from their credits (lib/payments/metered.ts
 * — hold the most it can cost, call, settle the real cost, refund the rest).
 * `db` null: no wallet to charge (Mongo backend, local dev) — runs unmetered.
 */
export type AiPayer = { userId: string; email?: string | null; db?: D1WithBatch | null };

/** A call the user's credits did not cover: the provider was never asked. */
export type NoCredits = { balance: number; need: number };

type Part = { type?: string; text?: unknown };
/** The characters of a chat call's prompt (text parts too): what its input tokens are held from. */
export const promptChars = (messages: readonly { content?: unknown }[]) =>
  messages.reduce((n, m) => {
    if (typeof m.content === "string") return n + m.content.length;
    if (!Array.isArray(m.content)) return n;
    return (m.content as Part[]).reduce(
      (k, p) => k + (typeof p?.text === "string" ? p.text.length : 0),
      n,
    );
  }, 0);

/**
 * The one charge seam for the reader's and self-intro's model calls: hold
 * `holdUsd` (lib/payments/prices.ts), run, settle. A refusal or a retried
 * key comes back as `{ ok: false }` and nothing was called.
 */
export function payAi<T>(
  ai: AiPayer,
  what: Feature,
  holdUsd: number,
  run: () => Promise<{ value: T; usd: number }>,
): Promise<Metered<T>> {
  return metered(
    { d1: ai.db ?? null },
    { userId: ai.userId, email: ai.email },
    { what, holdUsd },
    run,
  );
}

/** A delivered answer's price: its reported tokens, or — none reported — the whole hold. */
export const usageUsd = (
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  holdUsd: number,
) =>
  usage?.prompt_tokens || usage?.completion_tokens
    ? textUsd(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0)
    : holdUsd;

/** Words per model call, and the answer's ceiling per word (a gloss is a line). */
const BATCH = 40;
const TOKENS_PER_WORD = 80;

type Completion = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};
/** A chat completion call (the OpenAI-compatible body); Workers AI unless a test gives one. */
export type Complete = (body: Record<string, unknown>) => Promise<Completion>;

export const workersAiComplete: Complete = async (body) =>
  (await workersAiOpenAI().chat.completions.create(body as never, {
    timeout: 30_000,
  })) as Completion;

/** One model call: its glosses and its real cost; nothing when it fails or says nothing usable. */
async function generateBatch(
  complete: Complete,
  lang: string,
  chunk: { term: string; ex: string | null }[],
) {
  const messages = glossMessages(lang, chunk);
  const maxOut = chunk.length * TOKENS_PER_WORD;
  try {
    const r = await complete({
      model: PARTNER_AI_MODEL,
      messages,
      max_tokens: maxOut,
      temperature: 0.2,
      reasoning_effort: PARTNER_AI_REASONING,
    });
    const got = parseGlosses(
      r.choices?.[0]?.message?.content ?? "",
      chunk.map((x) => x.term),
    );
    const hold = textHoldUsd(PARTNER_AI_MODEL, promptChars(messages), maxOut);
    return { got, usd: usageUsd(PARTNER_AI_MODEL, r.usage, hold) };
  } catch (err) {
    console.error("read.gloss: model failed", String(err).slice(0, 200));
    return { got: new Map<string, string>(), usd: 0 };
  }
}

/**
 * The model's glosses for these headwords (the batches at once: the review
 * waits for them), written to word_gloss, paid from the user's credits: the
 * batches' most is held first, their real cost kept. Not covered → nothing
 * asked, `ai.refused` set.
 */
async function generate(
  db: D1Like,
  lang: string,
  words: { term: string; ex: string | null }[],
  ai: GlossAi,
  complete: Complete,
  share: (term: string) => boolean,
): Promise<Map<string, string>> {
  const chunks: (typeof words)[] = [];
  for (let i = 0; i < words.length; i += BATCH) chunks.push(words.slice(i, i + BATCH));
  const hold = chunks.reduce(
    (n, c) =>
      n +
      textHoldUsd(
        PARTNER_AI_MODEL,
        promptChars(glossMessages(lang, c)),
        c.length * TOKENS_PER_WORD,
      ),
    0,
  );
  const paid = await payAi(ai, "read.gloss", hold, async () => {
    const done = await Promise.all(chunks.map((c) => generateBatch(complete, lang, c)));
    return { value: done, usd: done.reduce((n, d) => n + d.usd, 0) };
  });
  if (!paid.ok) {
    if (paid.reason === "no-credits") ai.refused = { balance: paid.balance, need: paid.need };
    return new Map();
  }
  const made = new Map(paid.value.flatMap((d) => [...d.got]));
  const at = new Date().toISOString();
  for (const [term, back] of made)
    if (share(term))
      await db
        .prepare(
          "INSERT INTO word_gloss (lang, term, back, model, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(lang, term) DO NOTHING",
        )
        .bind(lang, term, back, PARTNER_AI_MODEL, at)
        .run();
  return made;
}

/** A gloss's payer; `refused` is set when their credits did not cover the model's words. */
export type GlossAi = AiPayer & { complete?: Complete; refused?: NoCredits };

/** Model calls per user per window: a guard against runaway cost, not a quota shown to anyone. */
const AI_LIMIT = { windowMs: 10 * 60_000, max: 30 };

/**
 * The range's words with a meaning wherever one can be found: the device's
 * deck meaning, else the decks over the book's lemmas, else word_gloss,
 * else (with `ai`) the model — written to word_gloss before it is used, unless
 * it is a phrase of private speech (`book.privateText`). A deck hit also
 * suggests its headword as the new card's term.
 */
export async function fillGlosses(
  db: D1Like,
  book: BookCtx,
  words: RangeWord[],
  ai: GlossAi | null,
): Promise<RangeWord[]> {
  if (book.lang === "und" || words.every((x) => x.back)) return words;
  const deck = await deckGlosses(book.lang).catch(() => new Map<string, GlossEntry>());
  const out = words.map((x) => {
    if (x.back || book.names?.has(x.w)) return x;
    const e = lookupGloss(x.w, book.lang, book.lem, deck);
    return e ? { ...x, term: e.term, reading: x.reading ?? e.reading ?? null, back: e.back } : x;
  });
  const open = out.filter((x) => !x.back && !book.names?.has(x.w));
  if (!open.length) return out;
  const head = (x: RangeWord) => headOf(x.w, book.lem);
  const known = await cachedGlosses(db, book.lang, [...new Set(open.map(head))]);
  // What the model makes goes into word_gloss, which everyone shares, so its
  // example is a line of the stored book, never text from this request (owner's
  // card, 2026-11-06). `x.ex` stays what it was: that device's own card.
  const surface = new Map(open.map((x) => [head(x), x.w]));
  const ask = [...surface]
    .filter(([h]) => !known.has(h))
    .map(([term, w]) => ({ term, ex: book.exampleOf?.(w) ?? null }));
  const complete = ai?.complete ?? (isWorkersAiConfigured() ? workersAiComplete : null);
  const share = (term: string) => !book.privateText || phraseTokens(term, book.lang).length < 2;
  if (
    ai &&
    complete &&
    ask.length &&
    (await routeLimit(`read-gloss:${ai.userId}`, AI_LIMIT)).allowed
  )
    for (const [term, back] of await generate(db, book.lang, ask, ai, complete, share))
      known.set(term, back);
  return out.map((x) => {
    if (x.back) return x;
    const back = known.get(head(x));
    if (!back) return x;
    // A generated meaning is the headword's: the new card goes under it.
    return { ...x, term: x.term ?? head(x), back };
  });
}
