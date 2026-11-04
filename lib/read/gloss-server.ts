// The I/O of a book word's meaning (the rules: lib/read/gloss.ts): the decks
// read from the Worker's assets once per isolate, the shared word_gloss rows,
// and the model for what neither has.
import type { D1Like } from "@/lib/d1/types";
import { PARTNER_AI_MODEL, PARTNER_AI_REASONING, costUsd } from "@/lib/partner-ai-config";
import { checkRateLimit } from "@/lib/rateLimit";
import { isWorkersAiConfigured, workersAiOpenAI } from "@/lib/workers-ai";
import type { BookCtx, RangeWord } from "./book-word-list";
import { glossMessages, headOf, lookupGloss, parseGlosses, type GlossEntry } from "./gloss";
import { readPublicText } from "./lemma-server";
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
 * What a generation cost, settled against the user. The credits are being
 * redesigned (owner, 2026-11-04: a new unit and real-cost metering), so for
 * now this only records the real cost; the debit goes here, and only here.
 */
export async function chargeAi(userId: string, use: { usd: number; words: number }) {
  void userId;
  console.log(JSON.stringify({ event: "read.gloss.cost", usd: use.usd, words: use.words }));
  return { ok: true as const };
}

/** Words per model call, and the answer's ceiling per word (a gloss is a line). */
const BATCH = 40;
const TOKENS_PER_WORD = 80;

/** One model call: its glosses and its real cost; nothing when it fails or says nothing usable. */
async function generateBatch(lang: string, chunk: { term: string; ex: string | null }[]) {
  try {
    const r = (await workersAiOpenAI().chat.completions.create(
      {
        model: PARTNER_AI_MODEL,
        messages: glossMessages(lang, chunk),
        max_tokens: chunk.length * TOKENS_PER_WORD,
        temperature: 0.2,
        reasoning_effort: PARTNER_AI_REASONING,
      } as never,
      { timeout: 30_000 },
    )) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      got: parseGlosses(
        r.choices?.[0]?.message?.content ?? "",
        chunk.map((x) => x.term),
      ),
      usd: costUsd(r.usage?.prompt_tokens ?? 0, r.usage?.completion_tokens ?? 0),
    };
  } catch (err) {
    console.error("read.gloss: model failed", String(err).slice(0, 200));
    return { got: new Map<string, string>(), usd: 0 };
  }
}

/** The model's glosses for these headwords, the batches at once (the review waits for them). */
async function generate(lang: string, words: { term: string; ex: string | null }[]) {
  const chunks: (typeof words)[] = [];
  for (let i = 0; i < words.length; i += BATCH) chunks.push(words.slice(i, i + BATCH));
  const done = await Promise.all(chunks.map((c) => generateBatch(lang, c)));
  const out = new Map(done.flatMap((d) => [...d.got]));
  return { out, usd: done.reduce((n, d) => n + d.usd, 0) };
}

/**
 * The range's words with a meaning wherever one can be found: the device's
 * deck meaning, else the decks over the book's lemmas, else word_gloss,
 * else (with `ai`) the model — written to word_gloss before it is used. A
 * deck hit also suggests its headword as the new card's term.
 */
export async function fillGlosses(
  db: D1Like,
  book: BookCtx,
  words: RangeWord[],
  ai: { userId: string } | null,
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
  const heads = [...new Set(open.map(head))];
  const known = await cachedGlosses(db, book.lang, heads);
  const ask = heads.filter((h) => !known.has(h));
  if (ask.length && ai && isWorkersAiConfigured()) {
    const limit = checkRateLimit(`read-gloss:${ai.userId}`, { windowMs: 10 * 60_000, max: 30 });
    if (limit.allowed) {
      const ex = new Map(open.map((x) => [head(x), x.ex ?? null]));
      const { out: made, usd } = await generate(
        book.lang,
        ask.map((term) => ({ term, ex: ex.get(term) ?? null })),
      );
      const at = new Date().toISOString();
      for (const [term, back] of made) {
        await db
          .prepare(
            "INSERT INTO word_gloss (lang, term, back, model, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(lang, term) DO NOTHING",
          )
          .bind(book.lang, term, back, PARTNER_AI_MODEL, at)
          .run();
        known.set(term, back);
      }
      if (usd > 0) await chargeAi(ai.userId, { usd, words: made.size });
    }
  }
  return out.map((x) => {
    if (x.back) return x;
    const back = known.get(head(x));
    if (!back) return x;
    // A generated meaning is the headword's: the new card goes under it.
    return { ...x, term: x.term ?? head(x), back };
  });
}
