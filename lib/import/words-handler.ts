/**
 * POST /api/import/words and GET /api/import/jobs (docs/import-material.md,
 * M1): a .txt/.csv word list → a new /words list, as an import job.
 *
 * The page sends the text itself (it never leaves the request: only counts
 * and the list it made are kept). The server parses it again with the same
 * parser the preview used (lib/import/wordlist.ts) and trusts nothing else
 * the page says about it.
 *
 * - `step: "preview"` answers the counts: new, already have, skipped.
 * - `step: "commit"` writes a job row (writing), the new list and its new
 *   words, then marks the job done (or failed) — inline, in this request; a
 *   queue takes over in a later slice.
 *
 * "Already have" = a word with a card in any of the user's lists, or an
 * entry of any list kept in D1 (imported decks and lists, books' lists),
 * compared in normalized form (normTerm). Words of built-in catalog lists
 * that were never reviewed are not counted: those live in static files.
 */
import { z } from "zod";
import type { D1Like } from "@/lib/d1/types";
import type { FlagValues } from "@/lib/flags";
import { checkRateLimit } from "@/lib/rateLimit";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { WordEntriesD1Repo } from "@/lib/repos/wordEntriesD1";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { IMPORT_LANGS, guessLang } from "@/lib/words/anki";
import {
  MAX_BYTES,
  WordListError,
  normTerm,
  parseWordList,
  splitKnown,
  toEntry,
  type ParsedWordList,
} from "./wordlist";

export const IMPORT_ANY_FLAG = "import.any";

/**
 * Who gets the word-list import (/import, the Import button on /words, both
 * routes): `import.any` is an owner-audience flag (lib/flags.ts). The owner
 * (`isDev`, the permission grant) has it with the flag on or off; nobody else,
 * on or off — the flag never opens it to everyone. An allowlist, when one is
 * made, widens it here; that is why every caller still passes the flags.
 */
export function importAnyOn(_flags: FlagValues | null | undefined, owner: boolean): boolean {
  return owner;
}

/** The body's ceiling: the text's cap plus room for JSON escaping and the other fields. */
const MAX_BODY = MAX_BYTES * 2 + 4096;
/** Requests per user per 10 minutes (preview and commit together). */
const RATE = { windowMs: 10 * 60_000, max: 60 };
const ROWS_PER_PREVIEW = 8;

const Body = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("preview"),
    text: z.string().max(MAX_BYTES),
    fileName: z.string().max(200).optional(),
  }),
  z.object({
    step: z.literal("commit"),
    text: z.string().max(MAX_BYTES),
    fileName: z.string().max(200).optional(),
    name: z.string().trim().min(1).max(120),
    lang: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
  }),
]);

export type WordImportDeps = {
  user: { email: string } | null;
  owner: boolean;
  flags: FlagValues;
  db: D1Like | null;
  now?: () => Date;
};

export type PreviewAnswer = {
  format: ParsedWordList["format"];
  header: boolean;
  columns: ParsedWordList["columns"];
  /** Words the import would add. */
  fresh: number;
  /** Words the user already has. */
  have: number;
  /** Rows left out, per reason; `skippedLines` lists the first of them. */
  skipped: number;
  skippedBy: ParsedWordList["skippedBy"];
  skippedLines: ParsedWordList["skipped"];
  /** The first new words, for the preview table. */
  sample: { term: string; back: string; reading?: string; ex?: string }[];
  /** A first guess at the list's language. */
  lang: string;
};

export type JobRow = {
  id: string;
  kind: string;
  name: string;
  status: string;
  note: string | null;
  result_ref: string | null;
  created_at: string;
  updated_at: string;
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/** Every term the user already has, normalized. */
export async function knownTerms(db: D1Like, email: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT term FROM word_cards WHERE email = ?1
       UNION SELECT term FROM word_list_entries WHERE email = ?1`,
    )
    .bind(email)
    .all<{ term: string }>();
  return new Set(results.map((r) => normTerm(r.term)));
}

/** The checks both steps share, cheapest first; the parsed body or the error response. */
async function readChecked(
  req: Request,
  deps: WordImportDeps,
): Promise<{ body: z.infer<typeof Body>; email: string; db: D1Like } | Response> {
  if (!sameOriginJsonPost(req)) return json({ error: "forbidden" }, 403);
  if (!deps.user) return json({ error: "unauthorized" }, 401);
  if (!importAnyOn(deps.flags, deps.owner)) return json({ error: "not-found" }, 404);
  if (!deps.db) return json({ error: "unavailable" }, 503);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY)
    return json({ error: "too-large" }, 413);
  const rate = checkRateLimit(`import-words:${deps.user.email}`, RATE);
  if (!rate.allowed)
    return json({ error: "rate-limited" }, 429, {
      "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)),
    });
  let data: unknown = null;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: "too-large" }, 413);
    data = JSON.parse(raw);
  } catch {
    return json({ error: "bad-request" }, 400);
  }
  const parsed = Body.safeParse(data);
  if (!parsed.success) {
    const tooBig = parsed.error.issues.some((i) => i.code === "too_big" && i.path[0] === "text");
    return json({ error: tooBig ? "too-large" : "bad-request" }, tooBig ? 413 : 400);
  }
  return { body: parsed.data, email: deps.user.email, db: deps.db };
}

function parseOrError(text: string, fileName?: string): ParsedWordList | Response {
  try {
    return parseWordList(text, fileName);
  } catch (e) {
    if (e instanceof WordListError)
      return json({ error: e.code }, e.code === "too-large" ? 413 : 400);
    throw e;
  }
}

export async function handleWordImport(req: Request, deps: WordImportDeps): Promise<Response> {
  const checked = await readChecked(req, deps);
  if (checked instanceof Response) return checked;
  const { body, email, db } = checked;
  const parsed = parseOrError(body.text, body.fileName);
  if (parsed instanceof Response) return parsed;
  const { fresh, have } = splitKnown(parsed.rows, await knownTerms(db, email));

  if (body.step === "preview") {
    const guess = guessLang(
      body.fileName ?? "",
      fresh.map((r) => r.term),
    );
    const answer: PreviewAnswer = {
      format: parsed.format,
      header: parsed.header,
      columns: parsed.columns,
      fresh: fresh.length,
      have: have.length,
      skipped: parsed.skippedCount,
      skippedBy: parsed.skippedBy,
      skippedLines: parsed.skipped,
      sample: fresh.slice(0, ROWS_PER_PREVIEW).map(({ term, back, reading, ex }) => ({
        term,
        back,
        ...(reading ? { reading } : {}),
        ...(ex ? { ex } : {}),
      })),
      lang: (IMPORT_LANGS as readonly string[]).includes(guess) ? guess : "",
    };
    return json(answer);
  }

  if (!fresh.length) return json({ error: "nothing-new", have: have.length }, 400);

  const now = deps.now ?? (() => new Date());
  const id = crypto.randomUUID();
  const at = now().toISOString();
  await db
    .prepare(
      `INSERT INTO import_jobs (id, email, kind, name, status, created_at, updated_at)
       VALUES (?, ?, 'wordlist', ?, 'writing', ?, ?)`,
    )
    .bind(id, email, (body.fileName || body.name).slice(0, 200), at, at)
    .run();
  const finish = (status: "done" | "failed", note: string, ref: string | null) =>
    db
      .prepare(
        `UPDATE import_jobs SET status = ?, note = ?, result_ref = ?, updated_at = ?
         WHERE id = ? AND email = ?`,
      )
      .bind(status, note, ref, now().toISOString(), id, email)
      .run();
  let listId: string | null = null;
  const words = new WordsD1Repo(db, email);
  try {
    listId = await words.createList({ name: body.name, lang: body.lang, source: `import:${id}` });
    const result = await new WordEntriesD1Repo(db, email).sync(listId, fresh.map(toEntry));
    const counts = {
      added: result.added,
      have: have.length,
      skipped: parsed.skippedCount + result.duplicates,
    };
    await finish("done", JSON.stringify(counts), listId);
    return json({ jobId: id, listId, ...counts });
  } catch (e) {
    // Logs carry ids and the error's name, never content.
    console.error("import.words: write failed", id, e instanceof Error ? e.name : "error");
    // No half list left behind: the words already written go with it.
    try {
      if (listId) await words.deleteList(listId);
      await finish("failed", "write-failed", null);
    } catch {
      // Best effort: the answer below is the same either way.
    }
    return json({ error: "write-failed", jobId: id }, 500);
  }
}

/** The user's latest import jobs, newest first, for the /import task strip. */
export async function handleImportJobs(deps: WordImportDeps): Promise<Response> {
  if (!deps.user) return json({ error: "unauthorized" }, 401);
  if (!importAnyOn(deps.flags, deps.owner)) return json({ error: "not-found" }, 404);
  if (!deps.db) return json({ jobs: [] });
  const { results } = await deps.db
    .prepare(
      `SELECT id, kind, name, status, note, result_ref, created_at, updated_at
       FROM import_jobs WHERE email = ? ORDER BY created_at DESC LIMIT 5`,
    )
    .bind(deps.user.email)
    .all<JobRow>();
  return json({ jobs: results });
}
